global._mckay_statistics_opt_out = true; // Opt out of node-steam-user stats

const optionDefinitions = [
    { name: 'config', alias: 'c', type: String, defaultValue: './config.js' }, // Config file location
    { name: 'steam_data', alias: 's', type: String } // Steam data directory
];

const winston = require('winston'),
    args = require('command-line-args')(optionDefinitions, { partial: true }),
    bodyParser = require('body-parser'),
    rateLimit = require('express-rate-limit'),
    utils = require('./lib/utils'),
    queue = new (require('./lib/queue'))(),
    InspectURL = require('./lib/inspect_url'),
    botController = new (require('./lib/bot_controller'))(),
    CONFIG = require(args.config),
    postgres = new (require('./lib/postgres'))(CONFIG.database_url, CONFIG.enable_bulk_inserts),
    gameData = new (require('./lib/game_data'))(CONFIG.game_files_update_interval, CONFIG.enable_game_file_updates),
    errors = require('./errors'),
    Job = require('./lib/job'),
    fs = require('fs'),
    os = require('os');

const nodeCluster = require('cluster');

const clusterCount = 20;

const botsCount = 10000;


if (nodeCluster.isMaster) {

    console.log('is master');

    (async () => {
        console.log(`Primary ${process.pid} is running`);

        // Fork workers.
        for (let i = 1; i < clusterCount + 1; i++) {
            nodeCluster.fork({
                clusterId: i
            });

            nodeCluster.on('exit', (worker, code, signal) => {
                console.log('worker %d died (%s). restarting...', worker.process.pid, signal || code);
                nodeCluster.fork({
                    clusterId: i
                });
            });
        }
    })();


} else {

    if (CONFIG.max_simultaneous_requests === undefined) {
        CONFIG.max_simultaneous_requests = 1;
    }
    winston.level = CONFIG.logLevel || 'debug';

    if (args.steam_data) {
        CONFIG.bot_settings.steam_user.dataDirectory = args.steam_data;
    }

    setTimeout(() => {

        fs.readFile('accounts.txt', 'utf8', async (err, data) => {
            if (err) {
                console.error(err);
                return;
            }

            const perCluster = botsCount / clusterCount;
            const clusterMax = perCluster * ((process.env.NODE_APP_INSTANCE * 1) + 1);

            const lines = data.split('\n').slice(clusterMax - perCluster, clusterMax);

            console.log('---------------------------');
            console.table({
                instanceId: process.env.NODE_APP_INSTANCE,
                linesLength: lines.length,
                clusterMax,
                perCluster,
                clusterCount,
                botsCount,
            });
            console.log('---------------------------');

            for await (const [index, line] of lines.entries()) {
                const [user, pass, email, ep] = line.split(':');
                const settings = Object.assign({}, CONFIG.bot_settings);

                botController.addBot({ user, pass, session: Math.round(index / 5) }, settings);

                await sleep(5000);

            }
        });
    }, process.env.NODE_APP_INSTANCE * 2000);

    /*
    for (let [i, loginData] of CONFIG.logins.entries()) {
        const settings = Object.assign({}, CONFIG.bot_settings);
    
        botController.addBot(loginData, settings);
    }
    */

    postgres.connect();

    // Setup and configure express
    const app = require('express')();
    app.use(function (req, res, next) {
        if (req.method === 'POST') {
            // Default content-type
            req.headers['content-type'] = 'application/json';
        }
        next();
    });
    app.use(bodyParser.json({ limit: '5mb' }));

    app.use(function (error, req, res, next) {
        // Handle bodyParser errors
        if (error instanceof SyntaxError) {
            errors.BadBody.respond(res);
        }
        else next();
    });


    if (CONFIG.trust_proxy === true) {
        app.enable('trust proxy');
    }

    CONFIG.allowed_regex_origins = CONFIG.allowed_regex_origins || [];
    CONFIG.allowed_origins = CONFIG.allowed_origins || [];
    const allowedRegexOrigins = CONFIG.allowed_regex_origins.map((origin) => new RegExp(origin));

    app.use(function (req, res, next) {
        if (CONFIG.allowed_origins.length > 0 && req.get('origin') != undefined) {
            // check to see if its a valid domain
            const allowed = CONFIG.allowed_origins.indexOf(req.get('origin')) > -1 ||
                allowedRegexOrigins.findIndex((reg) => reg.test(req.get('origin'))) > -1;

            if (allowed) {
                res.header('Access-Control-Allow-Origin', req.get('origin'));
                res.header('Access-Control-Allow-Methods', 'GET');
            }
        }
        next()
    });

    if (CONFIG.rate_limit && CONFIG.rate_limit.enable) {
        app.use(rateLimit({
            windowMs: CONFIG.rate_limit.window_ms,
            max: CONFIG.rate_limit.max,
            headers: false,
            handler: function (req, res) {
                errors.RateLimit.respond(res);
            }
        }))
    }

    app.get('/float', processRequest);
    app.post('/float', processRequest);
    app.get('/', processRequest);

    app.post('/bulk', (req, res) => {
        if (!req.body || (CONFIG.bulk_key && req.body.bulk_key != CONFIG.bulk_key)) {
            return errors.BadSecret.respond(res);
        }

        if (!req.body.links || req.body.links.length === 0) {
            return errors.BadBody.respond(res);
        }

        if (CONFIG.max_simultaneous_requests > 0 && req.body.links.length > CONFIG.max_simultaneous_requests) {
            return errors.MaxRequests.respond(res);
        }

        const job = new Job(req, res, /* bulk */ true);

        for (const data of req.body.links) {
            const link = new InspectURL(data.link);
            if (!link.valid) {
                return errors.InvalidInspect.respond(res);
            }

            let price;

            if (canSubmitPrice(req.body.priceKey, link, data.price)) {
                price = parseInt(req.query.price);
            }

            winston.info(link);

            job.add(link, price);
        }

        try {
            handleJob(job);
        } catch (e) {
            winston.warn(e);
            errors.GenericBad.respond(res);
        }
    });

    app.get('/stats', (req, res) => {
        res.json({
            bots_online: botController.getReadyAmount(),
            bots_total: botController.bots.length,
            queue_size: queue.queue.length,
            queue_concurrency: queue.concurrency,
            cluster_id: process.env.NODE_APP_INSTANCE,
        });
    });

    const http_server = require('http').Server(app);
    http_server.listen(CONFIG.http.port);
    winston.info('Listening for HTTP on port: ' + CONFIG.http.port);


    queue.process(botsCount / clusterCount, botController, async (job) => {
        const itemData = await botController.lookupFloat(job.data.link);
        winston.debug(`Received itemData for ${job.data.link.getParams().a}`);

        // Save and remove the delay attribute
        let delay = itemData.delay;
        delete itemData.delay;

        // add the item info to the DB
        await postgres.insertItemData(itemData.iteminfo, job.data.price);

        // Get rank, annotate with game files
        itemData.iteminfo = Object.assign(itemData.iteminfo, await postgres.getItemRank(itemData.iteminfo.a));
        gameData.addAdditionalItemProperties(itemData.iteminfo);

        itemData.iteminfo = utils.removeNullValues(itemData.iteminfo);
        itemData.iteminfo.stickers = itemData.iteminfo.stickers.map((s) => utils.removeNullValues(s));

        job.data.job.setResponse(job.data.link.getParams().a, itemData.iteminfo);

        return delay;
    });

    queue.on('job failed', (job, err) => {
        const params = job.data.link.getParams();
        winston.warn(`Job Failed! S: ${params.s} A: ${params.a} D: ${params.d} M: ${params.m} IP: ${job.ip}, Err: ${(err || '').toString()}`);

        job.data.job.setResponse(params.a, errors.TTLExceeded);
    });
}

process.on('uncaughtException', err => {
    console.log(`Uncaught Exception: ${err.message}`)
    // process.exit(1)
})
process.on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled rejection at ', promise, `reason: ${err.message}`)
    // process.exit(1)
})


function sleep(millis) {
    return new Promise((resolve) => setTimeout(resolve, millis));
}

async function handleJob(job) {
    // See which items have already been cached
    const itemData = await postgres.getItemData(job.getRemainingLinks().map(e => e.link));
    for (let item of itemData) {
        const link = job.getLink(item.a);

        if (!item.price && link.price) {
            postgres.updateItemPrice(item.a, link.price);
        }

        gameData.addAdditionalItemProperties(item);
        item = utils.removeNullValues(item);

        job.setResponse(item.a, item);
    }

    if (!botController.hasBotOnline()) {
        return job.setResponseRemaining(errors.SteamOffline);
    }

    if (CONFIG.max_simultaneous_requests > 0 &&
        (queue.getUserQueuedAmt(job.ip) + job.remainingSize()) > CONFIG.max_simultaneous_requests) {
        return job.setResponseRemaining(errors.MaxRequests);
    }

    if (CONFIG.max_queue_size > 0 && (queue.size() + job.remainingSize()) > CONFIG.max_queue_size) {
        return job.setResponseRemaining(errors.MaxQueueSize);
    }

    if (job.remainingSize() > 0) {
        queue.addJob(job, CONFIG.bot_settings.max_attempts);
    }
}

function canSubmitPrice(key, link, price) {
    return CONFIG.price_key && key === CONFIG.price_key && price && link.isMarketLink() && utils.isOnlyDigits(price);
}

function processRequest(req, res) {
    // Get and parse parameters
    let link;

    console.log(req.query, req.body);

    if ('url' in req.query) {
        link = new InspectURL(req.query.url);
    } else if ('url' in req.body) {
        link = new InspectURL(req.body.url);
    } else if ('a' in req.query && 'd' in req.query && ('s' in req.query || 'm' in req.query)) {
        link = new InspectURL(req.query);
    }

    if (!link || !link.getParams()) {
        return errors.InvalidInspect.respond(res);
    }

    const job = new Job(req, res, /* bulk */ false);

    let price;

    if (canSubmitPrice(req.query.priceKey, link, req.query.price)) {
        price = parseInt(req.query.price);
    }

    job.add(link, price);

    try {
        handleJob(job);
    } catch (e) {
        winston.warn(e);
        errors.GenericBad.respond(res);
    }
}
