const Twitter = require('twitter');
const CustomError = require('./custom_error');
const fetch = require('node-fetch');
const pattern = /(\d{2})-?(\d{8})/;

class TwitterApiError extends CustomError {
  constructor(error) {
    super(error.message);
  }
}

class ServiceRequestNotFoundError extends CustomError {
  constructor(error) {
    super(error.message);
  }
}

class DC311ApiUnavailableError extends CustomError {
  constructor(error) {
    super(error.message);
  }
}

class DC311RNApiUnavailableError extends CustomError {
  constructor(error) {
    super(error.message);
  }
}

module.exports = class Worker {
  constructor(credentials) {
    this.twitter = new Twitter(credentials);
  }

  async work() {
    const threshold = this.threshold();
    const tweets = await this.getUserTimelines('311dcgov', 'dc311rn');
    const repliedTo = tweets['dc311rn'].map(tweet => tweet.in_reply_to_status_id_str);
    const filtered = await this.filter(tweets['311dcgov'], threshold, repliedTo);
    const processed = await this.processAll(filtered.needs_reply);

    return {
      filtered_because_no_service_request: filtered.no_service_request.map(t => t.id_str),
      filtered_because_has_reply: filtered.has_reply.map(t => t.id_str),
      filtered_because_too_old: filtered.too_old.map(t => t.id_str),
      too_old_when_older_than: threshold,
      service_request_not_found: processed.not_found.map(o => `${o.tweet.id_str}: ${o.error.message}`),
      successfully_sent_reply: processed.replied.map(t => t.id_str),
      errored_while_replying: processed.errored,
    };
  }

  threshold() {
    const threshold = new Date();
    threshold.setHours(threshold.getHours() - 1);
    return threshold;
  }

  async getUserTimelines(...users) {
    try {
      const statuses = await Promise.all(users.map(u => this.getUserTimeline(u)));
      return users.reduce((obj, user, i) => ({...obj, [user]: statuses[i]}), {});
    }
    catch (error) {
      throw new TwitterApiError(error);
    }
  }

  async getUserTimeline(username) {
    return this.twitter.get('statuses/user_timeline', {
      screen_name: username,
      exclude_replies: false,
      tweet_mode: 'extended',
    });
  }

  async filter(tweets, threshold, replied_to_ids) {
    const no_service_request = [];
    const has_reply = [];
    const too_old = [];
    const needs_reply = [];

    tweets.forEach(tweet => {
      if (!pattern.test(tweet.full_text)) {
        no_service_request.push(tweet);
      }
      else if (replied_to_ids.includes(tweet.id_str)) {
        has_reply.push(tweet);
      }
      else if (new Date(Date.parse(tweet.created_at)) > threshold) {
        too_old.push(tweet);
      }
      else {
        needs_reply.push(tweet);
      }
    });

    return {
      no_service_request,
      has_reply,
      too_old,
      needs_reply,
    };
  }

  async processAll(tweets) {
    const results = await Promise.all(tweets.map(tweet => this.process(tweet)));

    const replied = [];
    const not_found = [];
    const errored = [];

    results.forEach((result) => {
      if (result.reply) {
        replied.push(result.original);
      }
      else {
        if (result.error instanceof ServiceRequestNotFoundError) {
          not_found.push({
            tweet: result.original,
            error: result.error,
          });
        }
        else {
          errored.push({
            tweet: result.original,
            error: result.error,
          });
        }
      }
    });

    return {
      replied,
      not_found,
      errored,
    };
  }

  async process(tweet) {
    const ids = this.parse(tweet.full_text);

    try {
      const service_requests = this.getServiceRequests(ids);
      const reply = await this.reply(tweet, service_requests);
      return { original: tweet, reply };
    }
    catch (error) {
      return { original: tweet, error };
    }
  }

  parse(text) {
    const ids = [];
    const r = new RegExp(pattern, "g");
    let matches;

    while (matches = r.exec(text)) {
      ids.push(`${matches[1]}-${matches[2]}`);
    }

    return ids;
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

      if (response.status === 404) {
        throw new ServiceRequestNotFoundError(body);
      }

      if (response.status === 504) {
        throw new DC311ApiUnavailableError(body);
      }

      throw new DC311RNApiUnavailableError(body);
    }));
  }
}
