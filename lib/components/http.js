const Koa = require('koa');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const views = require('koa-views');
const json = require('koa-json');
const onerror = require('koa-onerror');
const bodyparser = require('koa-bodyparser');
const session = require("koa-session2");
const RedisStore = require("./RedisStore");
// const logger = require('koa-logger');
const logger = require('omelo-logger').getLogger('omelo-rpc', __filename);

const cors = require('@koa/cors');
const cluster = require('cluster');
const numCPUs = require('os').cpus().length;

module.exports = function (app, opts) {
  return new Http(app, opts);
};

let Http = function (app, opts) {
  if (!opts) {
    assert.ok(false, 'http config is empty');
    process.exit(0);
    return;
  }

  this.app = app;
  this.http = new Koa();

  let serverId = app.getServerId();
  opts = opts[serverId];
  if (!opts) {
    assert.ok(false, serverId + ' http config is empty');
    process.exit(0);
    return;
  }

  this.useCluster = opts.useCluster;

  if (opts.useSSL) {
    this.host = opts.https.host;
    this.port = opts.https.port;
    this.sslOpts = {};
    this.sslOpts.key = fs.readFileSync(path.join(app.getBase(), opts.https.keyFile));
    this.sslOpts.cert = fs.readFileSync(path.join(app.getBase(), opts.https.certFile));
    this.useSSL = true;
  } else {
    this.host = opts.http.host;
    this.port = opts.http.port;
  }

  // session
  app.use(session({
    store: new RedisStore()
  }));

  // error handler
  onerror(this.http)

  // middlewares
  this.http.use(cors());
  this.http.use(bodyparser({
    enableTypes: ['json', 'form', 'text']
  }));
  this.http.use(json());
  // this.http.use(logger());

  if (opts.static) {
    this.http.use(require('koa-static')(path.join(this.app.getBase(), 'app/servers', this.app.getServerType(), 'public')));
  }

  if (opts.views) {
    this.http.use(views(path.join(this.app.getBase(), 'app/servers', this.app.getServerType(), 'views'), {
      extension: 'ejs'
    }))
  }

  this.beforeFilters = require('../../index').beforeFilters;
  this.afterFilters = require('../../index').afterFilters;
  this.server = null;
};

Http.prototype.loadRoutes = function () {

  let routesPath = path.join(this.app.getBase(), 'app/servers', this.app.getServerType(), 'routes');
  assert.ok(fs.existsSync(routesPath), 'Cannot find route path: ' + routesPath);

  let self = this;
  fs.readdirSync(routesPath).forEach(function (file) {
    if (/.js$/.test(file)) {
      let routePath = path.join(routesPath, file);
      // self.logger.info(routePath);
      const router = require('koa-router')();
      // let RouterClass = require(routePath)(self.app, self.http, self);
      require(routePath)(router);
      // routes
      self.http.use(router.routes(), router.allowedMethods());
    }
  });
}

Http.prototype.start = function (cb) {
  let self = this;

  this.beforeFilters.forEach(function (elem) {
    self.http.use(elem);
  });

  // logger
  this.http.use(async (ctx, next) => {
    const start = new Date();
    await next();
    const ms = new Date() - start;
    logger.info(`${ctx.method} ${ctx.url} - ${ms}ms`);

    // 通知 master 进程接收到了请求
    process.send && process.send({
      cmd: 'notifyRequest',
      pid: process.pid
    });
  });

  this.loadRoutes();

  this.afterFilters.forEach(function (elem) {
    self.http.use(elem);
  });

  if (this.useCluster && cluster.isMaster) {

    // 跟踪 http 请求
    let numReqs = {};
    setInterval(() => {
      logger.info(`numReqs = ${JSON.stringify(numReqs)}`);
    }, 1000);

    // 计算请求数目
    function messageHandler(msg) {
      console.error('11msg=', msg);
      if (msg.cmd && msg.cmd === 'notifyRequest') {
        console.error('msg=', msg);
        numReqs[msg.pid] += 1;
      }
    }

    // 启动 worker 并监听包含 notifyRequest 的消息
    for (let i = 0; i < numCPUs; i++) {
      cluster.fork();
    }

    for (const id in cluster.workers) {
      numReqs[cluster.workers[id].process.pid] = 0;
      cluster.workers[id].on('message', messageHandler);
    }

    cluster.on('exit', (worker, code, signal) => {
      logger.info(`http Work process ${worker.process.pid} exit`);
    });

    logger.info(`http cluster master ${process.pid} running`);
  } else {
    if (this.useSSL) {
      this.server = https.createServer(this.sslOpts, this.http.callback()).listen(this.port, this.host, function () {
        logger.info('http start', self.app.getServerId(), 'url: https://' + self.host + ':' + self.port);
        logger.info('http start success');
        process.nextTick(cb);
      });
    } else {
      this.server = http.createServer(this.http.callback()).listen(this.port, this.host, function () {
        logger.info('http start', self.app.getServerId(), 'url: http://' + self.host + ':' + self.port);
        logger.info('http start success');
        process.nextTick(cb);
      });
    }

    logger.info(`http Work process ${process.pid} running`);
  }
}

Http.prototype.afterStart = function (cb) {
  logger.info('Http afterStart');
  process.nextTick(cb);
}

Http.prototype.stop = function (force, cb) {
  let self = this;
  this.server.close(function () {
    logger.info('Http stop');
    cb();
  });
}