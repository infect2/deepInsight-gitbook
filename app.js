const https = require('https');
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const credentials = require('./credentials.js');

const mongoose = require('mongoose');

const path = require('path');
const logger = require('express-fluent-logger');
const amqp = require('amqp');
const multer = require('multer');

const { exec } = require('child_process');

const LOGGER_TIMEOUT = 3.0;
const DB_NAME = "report";

mongoose.Promise = Promise;

//multers disk storage settings
let storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, EXCEL_UPLOAD_DIRECTORY);
  },
  filename: (req, file, cb) => {
    let datetimestamp = Date.now();
    cb(null, file.fieldname + '-' + datetimestamp + '.' + file.originalname.split('.')[file.originalname.split('.').length -1]);
  }
});

const app = express();

// running enviroment setting
app.set('port', process.env.PORT || 3001);
app.set('mongodbIP', process.env.MONGODB.split(':')[0] || '172.17.0.4');
app.set('mongodbPort', process.env.MONGODB.split(':')[1] || '27017');
app.set('rabbitmqIP', process.env.RABBITMQ || '172.17.0.8');
app.set('loggerIP', process.env.LOGGER.split(':')[0] || '172.17.0.7');
app.set('loggerPort', process.env.LOGGER.split(':')[1] || '24224');

//RabbitMQ integration
let rabbit = amqp.createConnection({ host: app.get('rabbitmqIP') });

const cmd_html_base ='gitbook build template/';
const cmd_pdf_base = 'gitbook pdf template/';

let generateReport = (req, cb) => {
  let cmd;
  let templateDirName = req.questionnaireID.replace(/\s/g, '').replace(/:/g, '-');

  if(req.type == 'html') {
    cmd = cmd_html_base + templateDirName + ' ' + req.outputPath + 'report/';
  } else if (req.type == 'pdf' ) {
    cmd = cmd_pdf_base + templateDirName + ' ' + req.outputPath + 'report.pdf';
  } else {
    return cb(new Error('Invalid Report Type'), '', 'Invalid Report Type');
  }
  //whitespace is removed according to naming convention of template directory
  // cmd += req.questionnaireID.replace(/\s/g, '').replace(/:/g, '-');
  exec(cmd, (error, stdout, stderr) => {
    cb(error, stdout, stderr);
  });
};

let messageExchange;
rabbit.on('ready', () => {
  console.log('RabbitMQ is ready');
  rabbit.exchange('my-first-exchange', {type:'direct', autoDelete: false}, (ex) => {
    console.log('RabbitMQ: message exchange is created');
    messageExchange = ex;
  });
  rabbit.queue('first-queue-name', {autoDelete: false}, (q) => {
    q.bind('my-first-exchange', 'first-queue');
    q.subscribe( (message, headers, deliveryInfo, messageObject) => {
      console.log(headers);
      let req = {
        questionnaireID: headers.questionnaireID,
        surveyID: headers.surveyID,
        type: headers.format,
        templatePath: headers.templatePath || './template/',
        outputPath: headers.outputPath || '/tmp/'
      };
      generateReport( req, (error, stdout, stderr) => {
        let ret;
        if(error) {
          ret = {
            headers:{
              error: 'fail',
              message: stderr
            }
          };
        } else {
          ret = {
            headers: {
              error: 'success',
              message: stdout,
              type: 'html',
              outputPath: req.outputPath
            }
          };
        }
        messageExchange.publish('first-queue', {message: "success"}, ret);
      });
    });
  });
});

app.use((req,res,next) => {
  messageExchange.publish('first-queue', {message: req.url});
  next();
});

let mongoOpts = {
  useMongoClient: true,
  server: {
    socketOptions: {keepAlive: 1}
  },
  reconnectTries: 5,
  reconnectInterval: 1000
};

//logger setting
app.use(logger('deepinsight',{
  host: app.get('loggerIP'),
  port: app.get('loggerPort'),
  timeout: LOGGER_TIMEOUT,
  responseHeaders: ['x-userid']
}));

switch(app.get('env')){
  case 'development':
    console.log("development mode");
    app.use(require('morgan')('dev'));
    mongoose.connect("mongodb://" + app.get('mongodbIP') + ':' + app.get('mongodbPort') + '/' + DB_NAME, mongoOpts);
    break;
  case 'production':
    console.log("production mode");
    mongoose.connect("mongodb://" + app.get('mongodbIP') + ':' + app.get('mongodbPort') + '/' + DB_NAME, mongoOpts);
    app.use(require('express-logger')({
      path: __dirname + '/log/requests.log'
    }));
    break;
  default:
    throw new Error('Unknown execution environment: ' + app.get('env'));
}

app.use(bodyParser.json());

// CORS for API support
app.use('/api', require('cors')());

app.get('/',  (req, res) => {
  res.render('home');
});

//REST API Example
app.get('/api/purpose', (req, res) => {
  res.json({
          name: "deepinsight",
          id: 12345,
          description: "online survey",
          location: "South Korea",
  });
});

// 404 not found
app.use((req, res) => {
  res.status(404);
  res.render('404');
});

// 500 internal server error
app.use((err, req,res, next) => {
  console.error(err.stack);
  res.status(500);
  res.render('500');
});

let server;
let serverSptions = {
  key: fs.readFileSync(__dirname + '/keys/deepinsight.pem'),
  cert: fs.readFileSync(__dirname + '/keys/deepinsight.crt')
};

let startServer = () => {
  server = https.createServer(serverSptions, app).listen(app.get('port'), () => {
    console.log( 'Express started in ' + app.get('env') +
      ' mode on http://localhost:' + app.get('port') +
      '; press Ctrl-C to terminate.' );
  });
};

if(require.main === module){
  // application run directly; start app server
  startServer();
} else {
    // application imported as a module via "require": export function to create server
    module.exports = startServer;
}