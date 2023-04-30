
const redis = require('redis'),
    winston = require('winston');


class Redis {
    constructor(url) {
        this.client = redis.createClient({
            url,
        });
        this.client.connect();
    }

    async get(key) {
        return await this.client.get(key);
    }

    async set(key, value) {
        return await this.client.set(key, value);
    }

    del(key) {
        this.client.del(key);
    }

    incr(key) {
        this.client.incr(key);
    }

    incrBy(key, by) {
        this.client.incrBy(key, by);
    }

}

module.exports = Redis;
