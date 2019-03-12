const Twitter = require('twitter');
const CustomError = require('./custom_error');
const fetch = require('node-fetch');
const pattern = /(\d{2})-?(\d{8})/;

class TwitterApiError extends CustomError {
  constructor(error) {
    super(error.message);
  }
}

class DC311RNApiError extends CustomError {
  constructor(error) {
    super(error.message);
  }
}

const log = (filter, reason) => (tweet) => {
  const result = filter(tweet);

  if (!result) {
    console.log(`Tweet ${tweet.id_str} excluded because ${reason}. (${JSON.stringify({
      full_text: tweet.full_text,
      created_at: tweet.created_at,
    }, null, 2)})`);
  }

  return result;
};

const matches = (text) => {
  const numbers = [];
  const r = new RegExp(pattern, "g");
  let matches

  while (matches = r.exec(text)) {
    numbers.push(`${matches[1]}-${matches[2]}`)
  }

  return numbers
};

module.exports = class Worker {
  constructor(credentials) {
    this.twitter = new Twitter(credentials);
  }

  async processTweets() {
    let theirs, ours;

    try {
      [ theirs, ours ] = await Promise.all([
        this.get311dcgovtweets(),
        this.getdc311rntweets(),
      ]);
    }
    catch (error) {
      console.error(error);
      throw new TwitterApiError(error);
    }

    const threshold = this.threshold();

    const tweets = theirs
      .filter(log(tweet => pattern.test(tweet.full_text), 'it has no service request number'))
      .filter(log(tweet => !ours.find(t => t.in_reply_to_status_id_str === tweet.id_str), 'I have already replied'))
      .filter(log(tweet => new Date(Date.parse(tweet.created_at)) > threshold, `it was tweeted earlier than ${threshold}`));

    return Promise.all(tweets.map(async (tweet) => {
      let requests;

      try {
        requests = await this.getServiceRequests(matches(tweet.full_text));
      }
      catch (error) {
        console.error(`Unable to fetch service requests for tweet ${tweet.id_str}: `, error);
        return;
      }

      return this.reply(tweet, requests);
    }));
  }

  async get311dcgovtweets() {
    const { statuses } = await this.twitter.get('search/tweets', {
      result_type: 'recent',
      tweet_mode: 'extended',
      q: 'from:311dcgov',
      count: 15,
    });

    return statuses;
  }

  async getdc311rntweets() {
    return this.twitter.get('statuses/user_timeline', {
      screen_name: 'dc311rn',
      exclude_replies: false,
      tweet_mode: 'extended',
    })
  }

  async getServiceRequests(ids) {
    return Promise.all(ids.map(async (id) => {
      const url = `https://api.dc311rn.com/service_requests/${id}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': `dc311rn-twitterbot` }
      });
      const body = await response.json();

      if (response.ok) {
        return body;
      }
      else {
        throw new DC311RNApiError(body);
      }
    }));
  }

  async reply(tweet, serviceRequests) {
    const urls = serviceRequests.map((sr) => `https://www.dc311rn.com/${sr.service_request_id} (${sr.service_order.service.service_name})`)
    const text = `Status${urls.length > 1 ? "es" : ""}: ${urls.join(", ")} ✨`

    try {
      await this.twitter.post('statuses/update', {
        status: text,
        in_reply_to_status_id: tweet.id_str,
        auto_populate_reply_metadata: true,
        lat: serviceRequests[0].location.latitude,
        long: serviceRequests[0].location.longitude,
        display_coordinates: true,
        exclude_reply_user_ids: [
          '633993114', // @DCDHCD
          '18768730', // @DC_HSEMA
          '22509067', // @dcdmv
          '745716766643523585', // @OUC_DC
          '2964352984', // @DCMOCA
          '86340250', // @DCDPW
          '21789369', // @DDOTDC
          '301494181' // @DC_Housing
        ].join()
      });
    }
    catch (error) {
      console.error(`Could not post reply to tweet ${tweet.id_str}: `, { error });
      return;
    }
  }

  threshold() {
    const threshold = new Date();
    threshold.setHours(threshold.getHours() - 2);
    return threshold;
  }
}
