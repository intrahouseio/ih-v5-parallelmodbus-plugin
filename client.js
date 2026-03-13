/**
 * client.js
 * ИСПРАВЛЕННАЯ ВЕРСИЯ — forceReconnect теперь ПЕРИОДИЧЕСКИЙ (каждые ~12–15 сек)
 */

const util = require('util');

const tools = require('./tools');
const Modbus = require('modbus-serial');

const networkErrors = ['ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH'];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Client {
  constructor(plugin, params, idx, clientParams) {
    this.plugin = plugin;
    this.params = params;
    this.clientParams = clientParams;
    this.idx = idx;

    this.isOpen = false;
    this.isReconnecting = false;
    this.consecutiveErrors = 0;
    this.reconnectAttempts = 0;
    this.lastForceReconnectTime = 0;
    this.maxConsecutiveErrors = params.maxConsecutiveErrors || 5;

    this.client = new Modbus();
    this.polls = [];
    this.queue = [];
    this.channelsChstatus = {};
    this.channelsData = {};
    this.qToWrite = [];
    this.qToWriteRead = [];
    this.qToRead = [];
    this.message = {};
  }

 // ====================== АГРЕССИВНАЯ ОЧИСТКА СОКЕТА ДЛЯ WINDOWS ======================
  async destroyClient() {
    return new Promise(resolve => {
      try {
        if (this.client) {
          // Правильный путь к сокету в этой библиотеке
          if (this.client._port && this.client._port._socket) {
            this.plugin.log('Destroying real socket (Windows fix)...', 2);
            this.client._port._socket.destroy();
            this.client._port._socket.unref();
            delete this.client._port._socket;
          }
          if (this.client._port) {
            this.client._port.close?.();
            this.client._port = null;
          }

          this.client.close(err => {
            if (err) this.plugin.log('Close error: ' + err.message, 2);
            resolve();
          });
        } else {
          resolve();
        }
      } catch (e) {
        this.plugin.log('Error in destroyClient: ' + e.message, 2);
        resolve();
      }
    });
  }

  async connect() {
    this.client.setTimeout(this.params.timeout || 2000);
    const options = { port: this.clientParams.nodeport };
    const host = this.clientParams.nodeip;
    const transport = this.clientParams.nodetransport;

    try {
      this.plugin.log(`Connect to ${transport} ${host}:${this.clientParams.nodeport}`, 1);

      switch (transport) {
        case 'tcp':
          if (!this.client.isOpen) await this.client.connectTCP(host, options);
          break;
        case 'rtutcp':
        case 'rtuOverTcp':
          if (!this.client.isOpen) await this.client.connectTcpRTUBuffered(host, options);
          break;
        default:
          throw new Error(`Протокол ${transport} еще не имплементирован`);
      }

      this.isOpen = true;
      this.consecutiveErrors = 0;
      this.reconnectAttempts = 0;
      this.lastForceReconnectTime = Date.now();

      if (this.client._port && this.client._port._socket) {
        this.client._port._socket.setKeepAlive(true, 5000);
      }

      this.plugin.log('Connected successfully', 1);
    } catch (err) {
      this.isOpen = false;
      this.consecutiveErrors ++;
      this.sendAllChannelsBadStatus();
      if (this.allChannelsHaveBadStatus() && this.consecutiveErrors >= this.maxConsecutiveErrors && !this.isReconnecting) {
        await this.forceReconnect();
      }
      this.plugin.log(`Connection fail!`, 1);
      throw err;
    }
  }

  sendAllChannelsBadStatus() {
    let charr = [];
    this.polls.forEach(poll => {
      poll.ref.forEach(chitem => {
        if (!this.channelsChstatus[chitem.id]) {
          this.channelsChstatus[chitem.id] = 1;
          charr.push({ id: chitem.id, chstatus: 1, title: chitem.title });
        }
      });
    });
    if (charr.length > 0) this.plugin.sendData(charr);
  }

  allChannelsHaveBadStatus() {
    if (!this.polls || this.polls.length === 0) return false;
    for (const poll of this.polls) {
      for (const ch of poll.ref || []) {
        if (this.channelsChstatus[ch.id] !== 1) return false;
      }
    }
    return true;
  }

  async forceReconnect() {
    if (this.isReconnecting) return;

    const now = Date.now();
    if (now - this.lastForceReconnectTime < 10000) return; // минимум 10 сек между попытками

    this.isReconnecting = true;
    this.lastForceReconnectTime = now;
    this.reconnectAttempts++;

    this.plugin.log(`[FORCE RECONNECT] Попытка #${this.reconnectAttempts} | consecutiveErrors = ${this.consecutiveErrors}`, 1);

    try {
      //await this.close();
      await this.destroyClient();
      this.client = new Modbus();
      this.isOpen = false;

      await sleep(3500);

      await this.connect();

      this.isOpen = true;
      this.consecutiveErrors = 0;
      this.reconnectAttempts = 0;

      this.plugin.log('✅ Force reconnect УСПЕШНО', 1);
    } catch (err) {
      this.plugin.log(`❌ Force reconnect #${this.reconnectAttempts} НЕ УДАЛСЯ: ${err.message}`, 1);

      // КЛЮЧЕВОЙ ФИКС: откатываем время назад, чтобы попытка повторилась через ~12 сек
      this.lastForceReconnectTime = Date.now() - 8000;
      this.consecutiveErrors = this.maxConsecutiveErrors; // поддерживаем высокий счётчик

      const backoff = Math.min(30000, 3000 * this.reconnectAttempts);
      await sleep(backoff);
    } finally {
      this.isReconnecting = false;
    }
  }

  // ====================== ПАРСИНГ И ОЧЕРЕДИ ======================
  async parseCommand(message) {
    this.plugin.log(`Command '${message.command}' received`, 2);
    let payload = [];

    try {
      switch (message.command) {
        case 'read':
          if (message.data) {
            for (const item of message.data) {
              payload.push(Object.assign({ value: await this.readValueCommand(item) }, item));
            }
          }
          this.plugin.sendResponse(Object.assign({ payload }, message), 1);
          break;

        case 'write':
          if (message.data) {
            for (const item of message.data) {
              payload.push(await this.writeValueCommand(item));
            }
          }
          this.plugin.sendResponse(Object.assign({ payload }, message), 1);
          break;

        case 'readOnReq':
          if (message.data) {
            message.data.forEach(item => {
              item.vartype = item.manbo ? this.getVartypeMan(item) : this.getVartype(item.vartype);
            });
            this.setRead(message);
          }
          break;

        case 'writeWordArray':
          if (message.data) {
            const item = { unitid: message.data.unitid, address: message.data.address, fcw: 16, value: message.data.value, vartype: 'uintarray' };
            if (item.unitid !== undefined && item.address !== undefined && item.value !== undefined) {
              this.qToWrite.push(item);
              this.plugin.sendResponse(message, 1);
            } else {
              this.plugin.sendResponse(message, 0);
            }
          }
          break;

        default:
          break;
      }
    } catch (err) {
      this.plugin.sendResponse(Object.assign({ payload: message }, message), 0);
      this.checkError(err);
    }
  }

  setPolls(polls) {
    this.polls = polls;
    this.channelsData = {};
    this.consecutiveErrors = 0;
    this.reconnectAttempts = 0;
  }

  setRead(message) {
    this.qToRead = tools.getRequests(message.values, this.params);
    this.message = { unit: message.unit, param: message.param, sender: message.sender, type: message.type, uuid: message.uuid };
  }

  setWrite(data) {
    try {
      data.forEach(aitem => {
        if (aitem) {
          const item = tools.formWriteObject(aitem, this.params);
          if (item && item.vartype) this.qToWrite.push(item);
        }
      });
    } catch (err) {
      this.checkError(err);
    }
  }

  async sendNext(single) {
    const isOnce = single === true;
    let item;

    if (this.qToWriteRead.length) {
      item = this.qToWriteRead.shift();
      return this.writeReadRequest?.(item, !isOnce);
    }
    if (this.qToWrite.length) {
      item = this.qToWrite.shift();
      return this.write(item, !isOnce);
    }
    if (this.qToRead.length) {
      item = this.qToRead.shift();
      return this.readRequest(item, !isOnce);
    }

    if (this.queue.length <= 0) {
      this.polls.forEach(p => {
        p.curpoll = (p.curpoll || 0) + 1;
        if (p.curpoll >= p.polltimefctr) p.curpoll = 1;
      });
      this.queue = tools.getPollArray(this.polls);
    }

    item = this.queue.shift();
    if (typeof item !== 'object') item = this.polls[item];

    if (item) return this.read(item, !isOnce);

    await sleep(this.params.polldelay || 10);
    setImmediate(() => this.sendNext());
  }

  // ====================== ЧТЕНИЕ / ЗАПИСЬ (без изменений) ======================
  async read(item, allowSendNext) {
    this.client.setID(item.unitid);
    this.plugin.log(`READ: ${item.nodeip}:${item.nodeport} unit=${item.unitid} FC=${item.fcr} addr=${tools.showAddress(item.address)}`, 1);

    try {
      const res = await this.modbusReadCommand(item.fcr, item.address, item.length, item.ref, item);
      if (res?.buffer) {
        const data = tools.getDataFromResponse(res.buffer, item.ref);
        if (this.params.sendChanges == 1) {
          const arr = data.filter(d => {
            if (this.channelsData[d.id] !== d.value || this.channelsChstatus[d.id] == 1) {
              this.channelsChstatus[d.id] = d.chstatus;
              this.channelsData[d.id] = d.value;
              return true;
            }
            return false;
          });
          if (arr.length) this.plugin.sendData(arr);
        } else {
          data.forEach(el => this.channelsChstatus[el.id] = el.chstatus);
          this.plugin.sendData(data);
        }
      }
      this.consecutiveErrors = 0;
    } catch (err) {
      this.checkError(err);
    }

    if (this.qToWrite.length || allowSendNext) {
      if (!this.qToWrite.length) await sleep(this.params.polldelay || 1);
      setImmediate(() => this.sendNext());
    }
  }

  async readValueCommand(item) { /* ... */ 
    this.client.setID(item.unitid);
    try {
      const res = await this.modbusReadCommand(item.fcr, item.address, item.length, item.ref, item);
      return tools.parseBufferRead(res.buffer, { widx: item.offset, vartype: item.vartype, strlength: item.strlength });
    } catch (err) {
      this.checkError(err);
      throw err;
    }
  }

  async readRequest(item, allowSendNext) { /* ... */ 
    try {
      const res = await this.modbusReadCommand(item.fcr, item.address, item.length, item.ref, item);
      if (res?.buffer) this.plugin.sendData(tools.getDataFromResponse(res.buffer, item.ref));
    } catch (error) {
      this.message.result = "Read Request Fail";
      this.plugin.sendResponse(this.message, 1);
      this.checkError(error);
    }

    if (this.qToRead.length === 0) {
      this.message.result = "Read Request Ok";
      this.plugin.sendResponse(this.message, 1);
    }

    if (this.qToRead.length || allowSendNext) {
      if (!this.qToRead.length) await sleep(this.params.polldelay || 10);
      setImmediate(() => this.sendNext());
    }
  }

  async modbusReadCommand(fcr, address, length, ref, item) {
    if (!this.client.isOpen) await this.connect();

    try {
      fcr = Number(fcr);
      switch (fcr) {
        case 1: return await this.client.readCoils(address, length);
        case 2: return await this.client.readDiscreteInputs(address, length);
        case 3: return await this.client.readHoldingRegisters(address, length);
        case 4: return await this.client.readInputRegisters(address, length);
        default: throw new Error(`Функция ${fcr} на чтение не поддерживается`);
      }
    } catch (err) {
      if (!this.isReconnecting) this.consecutiveErrors++;

      if (this.allChannelsHaveBadStatus() && this.consecutiveErrors >= this.maxConsecutiveErrors && !this.isReconnecting) {
        await this.forceReconnect();
        if (item) this.queue.unshift(item);
      } else if (item && item.curretries < this.params.retries) {
        item.curretries++;
        this.queue.unshift(item);
      } else {
        this.sendAllChannelsBadStatus();
      }

      throw err;
    }
  }

  async write(item, allowSendNext) { /* ... */ 
    this.client.setID(parseInt(item.unitid));
    let fcw = item.fcw || (item.vartype === 'bool' ? 5 : 6);

    try {
      let val = item.value;
      if (fcw === 6 || fcw === 16) {
        val = tools.writeValue(item.value, item);
        if (Buffer.isBuffer(val) && val.length > 2) fcw = 16;

        if (item.bit) {
          item.ref = [tools.getRefobj(item)];
          const res = await this.modbusReadCommand(item.fcr, item.address, tools.getVarLen(item.vartype, item.strlength), item.ref);
          if (res?.buffer) {
            val = res.buffer;
            const byte = item.offset < 8 ? 1 : 0;
            const bit = item.offset < 8 ? item.offset : item.offset - 8;
            val[byte] = item.value === 1 ? val[byte] | (1 << bit) : val[byte] & ~(1 << bit);
          }
        }
      }

      this.plugin.log(`WRITE: ${item.nodeip}:${item.nodeport} FC=${fcw} addr=${tools.showAddress(item.address)}`, 1);
      await this.modbusWriteCommand(fcw, item.address, val);

      if (item.force) this.plugin.sendData([{ id: item.id, value: item.value }]);
      this.consecutiveErrors = 0;
    } catch (err) {
      this.checkError(err);
    }

    if (this.qToWrite.length || allowSendNext) {
      if (!this.qToWrite.length) await sleep(this.params.polldelay || 100);
      setImmediate(() => this.sendNext());
    }
  }

  async writeValueCommand(item) { /* ... */ 
    this.client.setID(item.unitid);
    let fcw = item.fcw || (item.vartype === 'bool' ? 5 : 6);

    try {
      let val = item.value;
      if (fcw === 6 || fcw === 16) {
        val = tools.writeValue(item.value, item);
        if (Buffer.isBuffer(val) && val.length > 2) fcw = 16;

        if (item.bit) {
          item.ref = [tools.getRefobj(item)];
          const res = await this.modbusReadCommand(item.fcr, item.address, tools.getVarLen(item.vartype, item.strlength), item.ref);
          if (res?.buffer) {
            val = res.buffer;
            const byte = item.offset < 8 ? 1 : 0;
            const bit = item.offset < 8 ? item.offset : item.offset - 8;
            val[byte] = item.value === 1 ? val[byte] | (1 << bit) : val[byte] & ~(1 << bit);
          }
        }
      }

      await this.modbusWriteCommand(fcw, item.address, val);
      if (item.force) this.plugin.sendData([{ id: item.id, value: item.value }]);
      this.consecutiveErrors = 0;
      return true;
    } catch (err) {
      this.checkError(err);
      throw err;
    }
  }

  async modbusWriteCommand(fcw, address, value) {
    if (!this.client.isOpen) await this.connect();

    try {
      switch (fcw) {
        case 5:  return await this.client.writeCoil(address, value);
        case 6:  return await this.client.writeRegister(address, value);
        case 15: return await this.client.writeCoils(address, [value]);
        case 16: return await this.client.writeRegisters(address, value);
        default: throw new Error(`Функция ${fcw} на запись не поддерживается`);
      }
    } catch (err) {
      if (!this.isReconnecting) this.consecutiveErrors++;
      if (this.allChannelsHaveBadStatus() && this.consecutiveErrors >= this.maxConsecutiveErrors && !this.isReconnecting) {
        await this.forceReconnect();
      }
      throw err;
    }
  }

  checkError(e) {
    if (e.errno && networkErrors.includes(e.errno)) {
      this.plugin.log(`Network ERROR: ${e.errno}`, 1);
    } else if (e.message.includes('Timeout') || e.code === 'TransactionTimedOutError' || e.message.includes('TCP Connection Timed Out')) {
      this.plugin.log(`Timeout: ${e.message}`, 2);
    } else {
      this.plugin.log(`ERROR: ${util.inspect(e)}`, 1);
    }
  }

  async stop() {
    this.isOpen = false;
    this.isReconnecting = false;
    this.queue = this.qToWrite = this.qToWriteRead = this.qToRead = [];
    try { await this.close(); } catch (e) {}
    this.plugin.log(`Client stopped`, 1);
  }

  close() {
    return new Promise((resolve, reject) => {
      this.client.close(err => err ? reject(err) : resolve());
    });
  }
}

module.exports = Client;