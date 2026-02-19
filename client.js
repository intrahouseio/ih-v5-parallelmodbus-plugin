/**
 * client.js
 */

const util = require('util');

const tools = require('./tools');
const Modbus = require('modbus-serial');

const networkErrors = ['ESOCKETTIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH'];
const sleep = ms => new Promise(resolve => nextTimer = setTimeout(resolve, ms));


class Client {
  constructor(plugin, params, idx, clientParams) {
    this.plugin = plugin;
    this.params = params;
    this.clientParams = clientParams;
    this.idx = idx;

    this.isOpen = false;
    this.client = new Modbus();
    this.polls = [];
    this.queue = [];
    this.channelsChstatus = {};
    this.channelsData = {};
    this.qToWrite = []; // Очередь на запись 
    this.qToWriteRead = [];
    this.qToRead = [];
    this.message = {};
  }

  async connect() {
    this.client.setTimeout(this.params.timeout);
    const options = { port: this.clientParams.nodeport };
    const host = this.clientParams.nodeip;
    const transport = this.clientParams.nodetransport;
    try {
      this.plugin.log("Connect to " + transport + " " + host + ":" + this.clientParams.nodeport, 1);

      switch (transport) {
        case 'tcp':
          if (!this.client.isOpen) await this.client.connectTCP(host, options);
          break;
        case 'rtutcp':
          if (!this.client.isOpen) await this.client.connectTcpRTUBuffered(host, options);

          break;
        case 'rtuOverTcp':
          if (!this.client.isOpen) await this.client.connectTelnet(host, options);

          break;
        /*case 'udp':
          if (!item.isOpen) await item.connectUDP(host, options);
          await sleep(100);
          break;*/
        default:
          throw new Error(`Протокол ${this.params.transport} еще не имплементирован`);
      }

    } catch (err) {
      let charr = [];
      this.polls.forEach(poll => {
        poll.ref.forEach(chitem => {
          if (!this.channelsChstatus[chitem.id]) {          
            this.channelsChstatus[chitem.id] = 1;
            charr.push({ id: chitem.id, chstatus: 1, title: chitem.title })
          }          
        })
      })
      if (charr.length > 0) this.plugin.sendData(charr);
      this.plugin.log(`Connection fail!`, 1);
      this.checkError(err);
    }
  }

  async parseCommand(message) {
    this.plugin.log(`Command '${message.command}' received. Data: ${util.inspect(message)}`, 2);
    let payload = [];

    try {
      switch (message.command) {
        case 'read':
          if (message.data !== undefined) {
            for (const item of message.data) {
              payload.push(Object.assign({ value: await this.readValueCommand(item) }, item));
            }
            // payload = message.data.map(item => Object.assign({ value: this.readValueCommand(item) }, item));
          }
          this.plugin.sendResponse(Object.assign({ payload }, message), 1);
          break;

        case 'write':
          if (message.data !== undefined) {
            for (const item of message.data) {
              payload.push(await this.writeValueCommand(item));
            }
            // payload = message.data.map(item => this.writeValueCommand(item));
          }

          this.plugin.sendResponse(Object.assign({ payload }, message), 1);
          break;
        case 'readOnReq':
          if (message.data != undefined) {
            message.data.forEach(item => {
              item.vartype = item.manbo ? this.getVartypeMan(item) : this.getVartype(item.vartype);
            })
            this.setRead(message);
          }
        case 'writeWordArray':
          if (message.data != undefined) {
            const item = {}
            if (message.data.unitid == undefined || message.data.address == undefined || message.data.value == undefined) {
              this.plugin.sendResponse(message, 0);
            } else {
              item.unitid = message.data.unitid;
              item.address = message.data.address;
              item.fcw = 16;
              item.value = message.data.value;
              item.vartype = 'uintarray';
              this.qToWrite.push(item);
              this.plugin.sendResponse(message, 1);
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
    this.plugin
    this.channelsData = {};
  }

  setRead(message) {
    this.qToRead = tools.getRequests(message.values, this.params);
    this.message = { unit: message.unit, param: message.param, sender: message.sender, type: message.type, uuid: message.uuid };
    // this.clientLog('message ' + util.inspect(this.qToRead), 2);
  }

  setWrite(data) {
    try {
      data.forEach(aitem => {
        if (aitem) {
          const item = tools.formWriteObject(aitem, this.params);
          if (item && item.vartype) {
            this.qToWrite.push(item);
            this.plugin.log(`Command to write: ${util.inspect(this.qToWrite)}`, 2);
          } else {
            this.plugin.log('ERROR: Command has empty vartype: ' + util.inspect(item), 2);
          }
        }
      });
    } catch (err) {
      this.checkError(err);
    }
  }

  async sendNext(single) {
    // this.clientLog('sendNext');
    /*if (!this.client.isOpen) {
      let channelsStatus = [];
      this.polls.forEach(item => {
        item.ref.forEach(item1 => {
          channelsStatus.push({ id: item1.id, chstatus: 1, title: item1.title })
        })
      })
      this.plugin.sendData(channelsStatus);
      await this.connect(this.clientParams);
    }*/

    let isOnce = false;
    if (typeof single !== undefined && single === true) {
      isOnce = true;
    }

    let item;
    if (this.qToWriteRead.length) {
      item = this.qToWriteRead.shift();
      return this.writeReadRequest(item, !isOnce);
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
      this.polls.forEach(pitem => {
        if (pitem.curpoll < pitem.polltimefctr) {
          pitem.curpoll++;
        } else {
          pitem.curpoll = 1;
        }
      });
      this.queue = tools.getPollArray(this.polls);
    }

    item = this.queue.shift();

    if (typeof item !== 'object') {
      item = this.polls[item];
    }

    if (item) {

      return this.read(item, !isOnce);
    }

    await sleep(this.params.polldelay || 1);
    setImmediate(() => {
      this.sendNext();
    });
  }

  async read(item, allowSendNext) {
    this.client.setID(item.unitid);
    this.plugin.log(
      `READ: ip:port = ${item.nodeip}:${item.nodeport}, unitId = ${item.unitid}, FC = ${item.fcr}, address = ${tools.showAddress(item.address)}, length = ${item.length
      }`,
      1
    );

    try {
      let res = await this.modbusReadCommand(item.fcr, item.address, item.length, item.ref, item);
      if (res && res.buffer) {

        const data = tools.getDataFromResponse(res.buffer, item.ref);
        if (this.params.sendChanges == 1) {
          let arr = data.filter(ditem => {
            if (this.channelsData[ditem.id] != ditem.value || this.channelsChstatus[ditem.id] == 1) {
              this.channelsChstatus[ditem.id] = ditem.chstatus;
              this.channelsData[ditem.id] = ditem.value;
              return true;
            }
          });
          if (arr.length > 0) this.plugin.sendData(arr);
        } else {
          data.forEach(el => {
            this.channelsChstatus[el.id] = el.chstatus;
          });
          this.plugin.sendData(data);
        }


      }
    } catch (err) {
      this.checkError(err);
    }

    if (this.qToWrite.length || allowSendNext) {
      if (!this.qToWrite.length) {
        await sleep(this.params.polldelay || 1); // Интервал между запросами
      }
      setImmediate(() => {
        this.sendNext();
      });
    }
  }

  async readValueCommand(item) {
    this.client.setID(item.unitid);
    this.plugin.log(
      `READ: ip:port = ${item.nodeip}:${item.nodeport}, unitId = ${item.unitid}, FC = ${item.fcr}, address = ${tools.showAddress(item.address)}, length = ${item.length
      }`,
      1
    );

    try {
      let res = await this.modbusReadCommand(item.fcr, item.address, item.length, item.ref, item);

      return tools.parseBufferRead(res.buffer, {
        widx: item.offset,
        vartype: item.vartype,
        strlength: item.strlength
      });
    } catch (err) {
      this.checkError(err);
    }
  }

  async modbusReadCommand(fcr, address, length, ref, item) {
    if (!this.client.isOpen) {
      await this.connect();
      if (!this.client.isOpen) throw new Error("Connection fail throw");
    }
    try {
      fcr = Number(fcr);

      switch (fcr) {
        case 2:
          return await this.client.readDiscreteInputs(address, length);
        case 1:
          return await this.client.readCoils(address, length);
        case 4:
          return await this.client.readInputRegisters(address, length);
        case 3:
          return await this.client.readHoldingRegisters(address, length);
        default:
          throw new Error(`Функция ${fcr} на чтение не поддерживается`);
      }
    } catch (err) {

      if (item != undefined && item.curretries < this.params.retries) {
        item.curretries++;
        this.queue.unshift(item);
      } else {
        let charr = [];
        ref.forEach(item => {
          if (!this.channelsChstatus[item.id]) {
            this.channelsChstatus[item.id] = 1;
            charr.push({ id: item.id, chstatus: 1, title: item.title })
          }
        });
        if (charr.length) this.plugin.sendData(charr);
        this.checkError(err);
      }

    }
  }

  async readRequest(item, allowSendNext) {
    try {
      const res = await this.modbusReadCommand(item.fcr, item.address, item.length, item.ref, item);
      if (res && res.buffer) {

        const data = tools.getDataFromResponse(res.buffer, item.ref);
        this.plugin.sendData(data);
      }
    } catch (error) {
      this.message.result = "Read Request Fail";
      this.plugin.sendResponse(this.message, 1);
      this.checkError(error);
    }

    if (this.qToRead.length == 0) {
      this.message.result = "Read Request Ok";
      this.plugin.sendResponse(this.message, 1);
    }


    if (this.qToRead.length || allowSendNext) {
      if (!this.qToRead.length) {
        await sleep(this.params.polldelay || 10); // Интервал между запросами
      }

      setImmediate(() => {
        this.sendNext();
      });
    }
  }

  checkError(e) {
    // TODO - выход пока заглушен!
    let exitCode = 0;
    if (e.errno && networkErrors.includes(e.errno)) {
      this.clientLog(`Network ERROR: ${e.errno}`, 1);
      exitCode = 1;
      //this.plugin.exit(exitCode, util.inspect(e));
    }
    if (e.message.includes("Timeout")) {
      exitCode = 2;
      //this.plugin.exit(exitCode, util.inspect(e));
    }
    else {
      this.clientLog('ERROR: ' + util.inspect(e), 1);

      // TODO Если все каналы c chstatus=1 - перезагрузить плагин?
      /*
      for (const item of this.channels) {
        if (!this.channelsChstatus[item.id]) return;
      }
      */
      this.clientLog('All channels have bad status! Exit with code 42', 1);
      exitCode = 42;
    }
    return exitCode;
  }

  async readRequest(item, allowSendNext) {
    try {
      const res = await this.readRegisters(item.adrclass, item.address, item.length);
      if (res && res.buffer) {

        const data = tools.getDataFromResponse(res.buffer, item.ref);
        this.plugin.sendData(data);
      }
    } catch (error) {
      this.message.result = "Read Fail";
      this.plugin.sendResponse(this.message, 1);
      this.checkError(error);
    }

    if (this.qToRead.length == 0) {
      this.message.result = "Read Ok";
      this.plugin.sendResponse(this.message, 1);
    }


    if (this.qToRead.length || allowSendNext) {
      if (!this.qToRead.length) {
        await sleep(this.params.polldelay || 10); // Интервал между запросами
      }

      setImmediate(() => {
        this.sendNext();
      });
    }
  }

  async write(item, allowSendNext) {
    this.client.setID(parseInt(item.unitid));
    let fcw;
    // let fcw = item.vartype == 'bool' ? 5 : 6;
    this.plugin.log('WRITE FCW: ' + item.fcw, 2);
    if (item.fcw) {
      fcw = item.fcw;
    } else {
      fcw = item.vartype == 'bool' ? 5 : 6;
    }
    try {
      let val = item.value;
      if (fcw == 6 || fcw == 16) {
        val = tools.writeValue(item.value, item);
        if (Buffer.isBuffer(val) && val.length > 2) fcw = 16;

        if (item.bit) {
          item.ref = [];
          let refobj = tools.getRefobj(item);
          refobj.widx = item.address;
          item.ref.push(refobj);
          const res = await this.modbusReadCommand(item.fcr, item.address, tools.getVarLen(item.vartype, item.strlength), item.ref);
          if (res && res.buffer) {
            val = res.buffer;
            if (item.offset < 8) {
              val[1] = item.value == 1 ? val[1] | (1 << item.offset) : val[1] & ~(1 << item.offset);
            } else {
              val[0] = item.value == 1 ? val[0] | (1 << (item.offset - 8)) : val[0] & ~(1 << (item.offset - 8));
            }
          }
        }

      }

      this.plugin.log(
        `WRITE: ip:port = ${item.nodeip}:${item.nodeport}, unitId = ${item.unitid}, FC = ${fcw}, address = ${tools.showAddress(item.address)}, value = ${util.inspect(
          val
        )}`,
        1
      );

      // Результат на запись - принять!!

      let res = await this.modbusWriteCommand(fcw, item.address, val);

      // Получили ответ при записи

      this.plugin.log(`Write result: ${util.inspect(res)}`, 1);

      if (item.force && res != undefined) {
        // Только если адрес для чтения и записи одинаковый
        // Отправить значение этого канала как при чтении
        this.plugin.sendData([{ id: item.id, value: item.value }]);
      }
    } catch (err) {
      this.checkError(err);
    }

    if (this.qToWrite.length || allowSendNext) {
      if (!this.qToWrite.length) {
        await sleep(this.params.polldelay || 1); // Интервал между запросами
      }
      setImmediate(() => {
        this.sendNext();
      });
    }
  }

  async writeValueCommand(item) {
    this.client.setID(item.unitid);
    let fcw;
    // let fcw = item.vartype == 'bool' ? 5 : 6;
    this.plugin.log('WRITE FCW: ' + item.fcw, 2);
    if (item.fcw) {
      fcw = item.fcw;
    } else {
      fcw = item.vartype == 'bool' ? 5 : 6;
    }
    try {
      let val = item.value;
      if (fcw == 6 || fcw == 16) {
        val = tools.writeValue(item.value, item);
        if (Buffer.isBuffer(val) && val.length > 2) fcw = 16;

        if (item.bit) {
          item.ref = [];
          let refobj = tools.getRefobj(item);
          refobj.widx = item.address;
          item.ref.push(refobj);
          const res = await this.modbusReadCommand(item.fcr, item.address, tools.getVarLen(item.vartype, item.strlength), item.ref);
          if (res && res.buffer) {
            val = res.buffer;
            if (item.offset < 8) {
              val[1] = item.value == 1 ? val[1] | (1 << item.offset) : val[1] & ~(1 << item.offset);
            } else {
              val[0] = item.value == 1 ? val[0] | (1 << (item.offset - 8)) : val[0] & ~(1 << (item.offset - 8));
            }
          }
        }
      }

      this.plugin.log(
        `WRITE: ip:port = ${item.nodeip}:${item.nodeport}, unitId = ${item.unitid}, FC = ${fcw}, address = ${tools.showAddress(item.address)}, value = ${util.inspect(
          val
        )}`,
        1
      );


      // let val = tools.writeValue(item.value, item);

      let res = await this.modbusWriteCommand(fcw, item.address, val);
      this.plugin.log(`Write result: ${util.inspect(res)}`, 1);
      if (item.force && res != undefined) {
        this.plugin.sendData([{ id: item.id, value: item.value }]);
      }

      return res;
    } catch (err) {
      this.checkError(err);
    }


  }

  async modbusWriteCommand(fcw, address, value) {
    if (!this.client.isOpen) {
      await this.connect(nodeid);
      if (!this.client.isOpen) throw new Error("Connection fail throw");
    }
    try {
      switch (fcw) {
        case 5:
          this.plugin.log(`writeCoil: address = ${tools.showAddress(address)}, value = ${value}`, 1);
          return await this.client.writeCoil(address, value);

        case 6:
          this.plugin.log(
            `writeSingleRegister: address = ${tools.showAddress(address)}, value = ${util.inspect(value)}`,
            1
          );
          return await this.client.writeRegister(address, value);

        case 15:
          this.plugin.log(`writeCoil: address = ${tools.showAddress(address)}, value = ${value}`, 1);
          return await this.client.writeCoils(address, [value]);

        case 16:
          this.plugin.log(
            `writeMultipleRegisters: address = ${tools.showAddress(address)}, value = ${util.inspect(value)}`,
            1
          );
          return await this.client.writeRegisters(address, value);

        default:
          throw new Error(`Функция ${fcw} на запись не поддерживается`);
      }
    } catch (err) {
      this.checkError(err);
    }
  }

  // Новый метод: Останавливает polling и закрывает соединение
  async stop() {
    this.plugin.log(`Stopping client for ${this.clientParams.nodeip}:${this.clientParams.nodeport}`, 1);
    this.isOpen = false;  // Блокируем reconnect и рекурсию в sendNext
    // Очищаем очереди, чтобы не генерировать новые запросы
    this.queue = [];
    this.polls = [];
    this.qToWrite = [];
    this.qToWriteRead = [];
    this.qToRead = [];
    try {
      await this.close();  // Закрываем Modbus
    } catch (err) {
      this.plugin.log(`Error during client stop: ${util.inspect(err)}`, 1);
    }
    this.plugin.log(`Client ${this.clientParams.nodeip}:${this.clientParams.nodeport} fully stopped`, 1);
  }

  close() {
    return new Promise((resolve, reject) => {
      this.client.close(err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  clientLog(txt, level = 0) {
    this.plugin.log('Client ' + this.idx + ' ' + txt, level, 1)
  }
}
module.exports = Client;
