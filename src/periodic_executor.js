const Worker = require('./models/worker');

exports.handler = async () => {
  const worker = new Worker({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  });

  try {
    await worker.processTweets();
  }
  catch (error) {
    console.error(error);
    throw error;
  }
};
