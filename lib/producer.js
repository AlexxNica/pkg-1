import { STORE_CODE, STORE_CONTENT } from '../prelude/common.js';
import assert from 'assert';
import bufferStream from 'simple-bufferstream';
import compile from './compiler.js';
import fs from 'fs';
import multistream from 'multistream';
import streamMeter from 'stream-meter';
import { wasReported } from './log.js';

const prepend = '(function(process, require, console, EXECPATH_FD, PAYLOAD_POSITION, PAYLOAD_SIZE) { ';
const append = '\n})'; // dont remove \n
const boundary = 4096;

function paddingBuffer (size) {
  const remainder = size % boundary;
  const padding = (remainder === 0 ? 0 : boundary - remainder);
  return Buffer.alloc(padding);
}

function makeBakeryBoxFromOptions (options) {
  const parts = [];
  for (let i = 0; i < options.length; i += 1) {
    parts.push(Buffer.from(options[i]));
    parts.push(Buffer.alloc(1));
  }
  parts.push(Buffer.alloc(1));
  const buffer = Buffer.concat(parts);

  const sentinel = new Buffer(16);
  sentinel.writeInt32LE(0x4818c4df, 0);
  sentinel.writeInt32LE(0x7ac30670, 4);
  sentinel.writeInt32LE(0x56558a76, 8);
  sentinel.writeInt32LE(buffer.length, 12);
  return Buffer.concat([ sentinel, buffer ]);
}

function makePreludeBoxFromPrelude (prelude) {
  const buffer = new Buffer(prepend + prelude + append);
  const sentinel = new Buffer(16);
  sentinel.writeInt32LE(0x26e0c928, 0);
  sentinel.writeInt32LE(0x41f32b66, 4);
  sentinel.writeInt32LE(0x3ea13ccf, 8);
  sentinel.writeInt32LE(buffer.length, 12);
  return Buffer.concat([ sentinel, buffer ]);
}

function makePayloadHeader () {
  const sentinel = new Buffer(16);
  sentinel.writeInt32LE(0x75148eba, 0);
  sentinel.writeInt32LE(0x6fbda9b4, 4);
  sentinel.writeInt32LE(0x2e20c08d, 8);
  sentinel.writeInt32LE(0, 12); // PKG_PAYLOAD_SIZE
  return sentinel;
}

export default function ({ backpack, options, target }) {
  if (!Buffer.alloc) {
    throw wasReported('Your node.js does not have Buffer.alloc. Please upgrade!');
  }

  return new Promise((resolve, reject) => {
    const { prelude, stripe } = backpack;

    const vfs = {};
    for (const task of stripe) {
      if (!vfs[task.snap]) {
        vfs[task.snap] = {};
      }
    }

    let meter;
    let count = 0;

    function pipeToNewMeter (s) {
      meter = streamMeter();
      return s.pipe(meter);
    }

    function next (s) {
      count += 1;
      return pipeToNewMeter(s);
    }

    let payloadPos = 0;
    let payloadLength = 0;
    let recentTask;

    multistream((cb) => {
      if (count === 0) {
        return cb(undefined, next(
          fs.createReadStream(target.binaryPath)
        ));
      } else
      if (count === 1) {
        return cb(undefined, next(
          bufferStream(paddingBuffer(meter.bytes))
        ));
      } else
      if (count === 2) {
        return cb(undefined, next(
          bufferStream(makeBakeryBoxFromOptions(options))
        ));
      } else
      if (count === 3) {
        return cb(undefined, next(
          bufferStream(paddingBuffer(meter.bytes))
        ));
      } else
      if (count === 4) {
        return cb(undefined, next(
          bufferStream(makePayloadHeader())
        ));
      } else
      if (count === 5) {
        if (recentTask) {
          const { snap, store } = recentTask;
          vfs[snap][store] = [ payloadPos, meter.bytes ];
          payloadPos += meter.bytes;
        }

        payloadLength += meter.bytes;
        if (!stripe.length) {
          return cb(undefined, next(
            bufferStream(paddingBuffer(payloadLength))
          ));
        }

        const task = stripe.shift();
        recentTask = task;

        if (task.file) {
          assert.equal(task.store, STORE_CONTENT); // others must be buffers from walker
          return cb(undefined, pipeToNewMeter(fs.createReadStream(task.file)));
        } else
        if (task.buffer) {
          if (task.store === STORE_CODE) {
            return compile(options, target, task.buffer, (error, buffer) => {
              if (error) return cb(error);
              cb(undefined, pipeToNewMeter(bufferStream(buffer)));
            });
          } else {
            return cb(undefined, pipeToNewMeter(bufferStream(task.buffer)));
          }
        } else {
          assert(false, 'producer: bad stripe task');
        }
      } else
      if (count === 6) {
        return cb(undefined, next(
          bufferStream(makePreludeBoxFromPrelude(
            prelude.replace('%VIRTUAL_FILESYSTEM%', JSON.stringify(vfs))
          ))
        ));
      } else {
        return cb();
      }
    }).on('error', (error) => {
      reject(error);
    }).pipe(
      fs.createWriteStream(target.output)
    ).on('close', () => {
      resolve();
    });
  });
}
