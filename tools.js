/**
 * Функции разбора и формирования данных
 */
const util = require('util');

exports.formWriteObject = formWriteObject;
exports.getVartype = getVartype;
exports.getVartypeMan = getVartypeMan;
exports.showAddress = showAddress;

exports.parseBufferRead = parseBufferRead;
exports.parseBufferWrite = parseBufferWrite;
exports.readValue = readValue;
exports.writeValue = writeValue;
exports.getPolls = getPolls;
exports.getRequests = getRequests;
exports.getWriteRequests = getWriteRequests;
exports.getPollArray = getPollArray;
exports.getDataFromResponse = getDataFromResponse;
exports.getCorrectDataFromResponse = getCorrectDataFromResponse;
exports.transformStoH = transformStoH;
exports.transformHtoS = transformHtoS;


function formWriteObject(chanItem, params) {
  if (!chanItem) return;

  // Копировать свойства канала в объект
  const res = {
    id: chanItem.id,
    nodeip: chanItem.nodeip,
    nodeport: chanItem.nodeport,
    nodetransport: chanItem.nodetransport,
    unitid: chanItem.unitid,
    value: Number(chanItem.value) || 0,
    command: chanItem.value || 'set',
    manbo: chanItem.manbo
  };

  if (chanItem.manbo) {
    res.manbo8 = chanItem.manbo8;
    res.manbo16 = chanItem.manbo16;
    res.manbo32 = chanItem.manbo32;
    res.manbo64 = chanItem.manbo64;
  }

  if (chanItem.diffw || (!chanItem.r && chanItem.wvartype && chanItem.wvartype)) {
    res.address = parseInt(chanItem.waddress);
    res.vartype = chanItem.wvartype;
    res.fcw = parseInt(chanItem.fcw);
    res.force = 0;
  } else {
    res.address = parseInt(chanItem.address);
    res.vartype = chanItem.vartype;
    res.fcw = parseInt(chanItem.fcw);
    res.force = chanItem.req ? 1 : 0;
  }
  if (chanItem.parentoffset) res.address += parseInt(chanItem.parentoffset);

  if (!res.vartype) return res;

  res.vartype = res.manbo ? getVartypeMan(res) : getVartype(res.vartype, params);
  if (chanItem.usek) {
    res.usek = 1;
    res.ks0 = parseInt(chanItem.ks0);
    res.ks = parseInt(chanItem.ks);
    res.kh0 = parseInt(chanItem.kh0);
    res.kh = parseInt(chanItem.kh);
  }

  if (chanItem.bit) res.offset = chanItem.offset;
  return res;
}


function getVartype(vt, params) {
  let bits = vt.substr(-2, 2);

  if (vt === 'int8' || vt === 'uint8') {
    return vt + params.bo8;
  }

  if (bits === '16') {
    return vt + params.bo16;
  }

  if (bits === '32' || vt === 'float') {
    return vt + params.bo32;
  }

  if (bits === '64' || vt === 'double') {
    return vt + params.bo64;
  }

  return vt;
}

function getVartypeMan(item) {
  let vt = item.vartype;
  let bits = vt.substr(-2, 2);

  if (vt === 'int8' || vt === 'uint8') {
    return vt + item.manbo8;
  }

  if (bits === '16') {
    return vt + item.manbo16;
  }

  if (bits === '32' || vt === 'float') {
    return vt + item.manbo32;
  }

  if (bits === '64' || vt === 'double') {
    return vt + item.manbo64;
  }

  return vt;
}

function showAddress(address) {
  if (isNaN(address)) return 'NaN';
  return `${address} (0x${Number(address).toString(16)})`;
}

function getDataFromResponse(buf, ref) {
  if (!ref || !util.isArray(ref)) {
    return;
  }

  return ref.map(item => ({ id: item.id, value: readValue(buf, item), title: item.title, chstatus: 0 }));
}

function getCorrectDataFromResponse(buf, ref) {
  if (!ref || !util.isArray(ref)) {
    return;
  }

  return ref.map(item => ({
    id: item.id,
    value: readValue(buf, item),
    writeValue: item.value,
    title: item.title,
    chstatus: 0
  }));
}

function getRequests(channels, params) {
  if (!channels || !util.isArray(channels)) {
    return [];
  }

  let result = [];
  let maxReadLen;

  channels.sort(byorder('nodeip,nodeport,nodetransport,unitid,fcr,address'));

  const config = channels.filter(item => item.req);
  let i = 0;
  let current;
  let length;

  while (i < config.length) {
    let item = config[i];
    if (item.fcr == 1 || item.fcr == 2) {
      maxReadLen = params.maxbitreadlen || 1000;
    } else {
      maxReadLen = params.maxreadlen || 125;
    }
    if (!current || isDiffBlock(item, current) || getLengthAfterAdd(item, current) > maxReadLen) {
      // Записать предыдущий элемент
      if (current && length) {
        result.push(Object.assign({ length }, current));
      }
      length = 0;
      current = {
        nodeip: item.nodeip,
        nodeport: item.nodeport,
        nodetransport: item.nodetransport,
        unitid: item.unitid,
        desc: item.desc,
        fcr: item.fcr,
        address: item.address,
        polltimefctr: item.polltimefctr || 1,
        curpoll: 1,
        curretries: 1,
        ref: []
      };
    }

    length = getLengthAfterAdd(item, current);
    let refobj = getRefobj(item);
    refobj.widx = item.address - current.address;


    current.ref.push(refobj);
    const writeValueBuf = writeValue1(item.value, item);
    try {
      current.bufdata = Buffer.concat([current.bufdata, writeValueBuf], current.bufdata.length + writeValueBuf.length);
    } catch (error) {
      plugin.log('Error ' + error);
    }

    i++;
  }

  if (current && length) {
    result.push(Object.assign({ length }, current));
  }

  return result;
}

function getPolls(channels, params) {
  if (!channels || !util.isArray(channels)) {
    return [];
  }

  let result = [];
  let maxReadLen;

  channels.sort(byorder('nodeip,nodeport,nodetransport,unitid,fcr,address'));

  // Выбираем переменные, которые можно читать группами, и формируем команды опроса
  // Формируем автоматические группы
  const config = channels.filter(item => item.gr && !item.grman && item.r && !item.req);
  let i = 0;
  let current;
  let length;

  while (i < config.length) {
    let item = config[i];
    if (item.fcr == 1 || item.fcr == 2) {
      maxReadLen = params.maxbitreadlen || 1000;
    } else {
      maxReadLen = params.maxreadlen || 125;
    }
    if (!current || isDiffBlock(item, current) || getLengthAfterAdd(item, current) > maxReadLen) {
      // Записать предыдущий элемент
      if (current && length) {
        result.push(Object.assign({ length }, current));
      }

      length = 0;
      current = {
        nodeip: item.nodeip,
        nodeport: item.nodeport,
        nodetransport: item.nodetransport,
        unitid: item.unitid,
        desc: item.desc,
        fcr: item.fcr,
        address: item.address,
        polltimefctr: item.polltimefctr || 1,
        curpoll: 1,
        curretries: 1,
        ref: []
      };
    }

    length = getLengthAfterAdd(item, current);

    let refobj = getRefobj(item);
    refobj.widx = item.address - current.address;

    current.ref.push(refobj);

    i++;
  }

  if (current && length) {
    result.push(Object.assign({ length }, current));
  }

  // Результат должен быть такой:
  /*
    return [
        {desc:'AI', address: 4000, length:4, fcr:'4', ref:
             [{id:'ch1', widx:0, vartype:'int16'},
              {id:'ch2', widx:1, vartype:'int16'}]
        }    
    ];
    */
  let currentMan;
  let lengthMan;

  // Добавить ручную группировку чтения
  const configMan = channels.filter(item => item.gr && item.grman && item.r && !item.req);
  configMan.sort(byorder('nodeip,nodeport,nodetransport,unitid,grmanstr,address,polltimefctr'));
  configMan.forEach(item => {
    if (item.fcr == 1 || item.fcr == 2) {
      maxReadLen = params.maxbitreadlen || 1000;
    } else {
      maxReadLen = params.maxreadlen || 125;
    }
    if (!currentMan || isDiffBlockMan(item) || getLengthManAfterAdd(item) > maxReadLen) {
      // Записать предыдущий элемент
      if (currentMan && lengthMan) {
        result.push(Object.assign({ length: lengthMan }, currentMan));
      }

      lengthMan = 0;
      currentMan = {
        nodeip: item.nodeip,
        nodeport: item.nodeport,
        nodetransport: item.nodetransport,
        unitid: item.unitid,
        desc: item.desc,
        fcr: item.fcr,
        manbo: item.manbo,
        address: item.address,
        grmanstr: item.parentnodefolder ? item.parentnodefolder + item.grmanstr : item.grmanstr,
        polltimefctr: item.polltimefctr || 1,
        curpoll: 1,
        curretries: 1,
        ref: []
      };
    }
    lengthMan = getLengthManAfterAdd(item);

    let refobjMan = getRefobj(item);
    refobjMan.widx = item.address - currentMan.address;

    currentMan.ref.push(refobjMan);
  });

  if (currentMan && lengthMan) {
    result.push(Object.assign({ length: lengthMan }, currentMan));
  }

  // Результат должен быть такой:
  /*
    return [
        {desc:'AI', address: 4000, length:4, fcr:'4', grmanstr: 'group1', polltimefctr: 1 ref:
             [{id:'ch1', widx:0, vartype:'int16'},
              {id:'ch2', widx:1, vartype:'int16'}]
        }    
    ];
    */

  // Добавить негрупповое чтение
  channels
    .filter(item => !item.gr && item.r && !item.req)
    .forEach(item => {
      if (!item.vartype) {
        console.log('NO VARTYPE: ' + util.inspect(item));
      } else {
        result.push({
          length: getVarLen(item.vartype),
          nodeip: item.nodeip,
          nodeport: item.nodeport,
          nodetransport: item.nodetransport,
          unitid: item.unitid,
          desc: item.desc,
          fcr: item.fcr,
          manbo: item.manbo,
          address: item.address,
          polltimefctr: item.polltimefctr || 1,
          curpoll: 1,
          ref: [getRefobj(item)]
        });
      }
    });

  return result;

  function isDiffBlockMan(citem) {
    let grmanstr = citem.parentnodefolder ? citem.parentnodefolder + citem.grmanstr : citem.grmanstr;
    return citem.nodeip != current.nodeip || citem.nodeport != current.nodeport || citem.unitid != current.unitid || citem.fcr != current.fcr || grmanstr != currentMan.grmanstr;
  }

  function getLengthManAfterAdd(citem) {
    return citem.address - currentMan.address + getVarLen(citem.vartype);
  }
  function isDiffBlock(citem) {
    return citem.nodeip != current.nodeip || citem.nodeport != current.nodeport || citem.unitid != current.unitid || citem.fcr != current.fcr;
  }
  
  function getLengthAfterAdd(citem) {
    return citem.address - current.address + getVarLen(citem.vartype);
  }
}


function getRefobj(item) {
  const title = item.parentname ? item.parentname + '/' + item.chan : item.chan;
  let refobj = {
    id: item.id,
    title,
    vartype: item.vartype,
    widx: 0,
    curretries: 1,
    value: item.value
  };

  if (item.vartype != 'bool') {
    if (item.bit) {
      refobj.bit = item.bit;
      refobj.offset = item.offset;
    }

    if (item.usek) {
      refobj.usek = item.usek;
      refobj.ks0 = parseInt(item.ks0) || 0;
      refobj.ks = parseInt(item.ks) || 0;
      refobj.kh0 = parseInt(item.kh0) || 0;
      refobj.kh = parseInt(item.kh) || 0;

      if (refobj.ks <= refobj.ks0) {
        refobj.ks = refobj.ks0 + 1;
      }

      if (refobj.kh <= refobj.kh0) {
        refobj.kh = refobj.kh0 + 1;
      }
    }
  }
  return refobj;
}

function getPollArray(polls) {
  // Пока просто заполяем индексы всех записей
  // Нужно будет отсекать с низким приоритетом позднее
  return polls.reduce((arr, item, index) => {
    item.curretries = 1;
    if (item.curpoll == item.polltimefctr) arr.push(index);
    return arr;
  }, []);
}

function parseBufferRead(buffer, item) {
  let buf;
  let i1;
  let i2;
  let offset = item.widx;
  let vartype = item.vartype;

  switch (vartype) {
    case 'bool':
      return getBitValue(buffer, offset);
    case 'uint8be':
      return buffer.readUInt8(offset * 2 + 1);
    case 'uint8le':
      return buffer.readUInt8(offset * 2);
    case 'int8be':
      return buffer.readInt8(offset * 2 + 1);
    case 'int8le':
      return buffer.readInt8(offset * 2);
    case 'uint16be':
      return buffer.readUInt16BE(offset * 2);
    case 'uint16le':
      return buffer.readUInt16LE(offset * 2);
    case 'int16be':
      return buffer.readInt16BE(offset * 2);
    case 'int16le':
      return buffer.readInt16LE(offset * 2);
    case 'uint32be':
      return buffer.readUInt32BE(offset * 2);
    case 'uint32le':
      return buffer.readUInt32LE(offset * 2);
    case 'uint32sw':
      // buf = new Buffer(4);
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 2];
      buf[1] = buffer[offset * 2 + 3];
      buf[2] = buffer[offset * 2 + 0];
      buf[3] = buffer[offset * 2 + 1];
      return buf.readUInt32BE(0);
    case 'uint32sb':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 1];
      buf[1] = buffer[offset * 2 + 0];
      buf[2] = buffer[offset * 2 + 3];
      buf[3] = buffer[offset * 2 + 2];
      return buf.readUInt32BE(0);
    case 'int32be':
      return buffer.readInt32BE(offset * 2);
    case 'int32le':
      return buffer.readInt32LE(offset * 2);
    case 'int32sw':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 2];
      buf[1] = buffer[offset * 2 + 3];
      buf[2] = buffer[offset * 2 + 0];
      buf[3] = buffer[offset * 2 + 1];
      return buf.readInt32BE(0);
    case 'int32sb':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 1];
      buf[1] = buffer[offset * 2 + 0];
      buf[2] = buffer[offset * 2 + 3];
      buf[3] = buffer[offset * 2 + 2];
      return buf.readInt32BE(0);
    case 'uint64be':
      return Number(buffer.readBigUInt64BE(offset * 2));
    case 'uint64sw':
      buf = Buffer.alloc(8);
      //B7B8B5B6B3B4B1B2
      buf[0] = buffer[offset * 2 + 6];
      buf[1] = buffer[offset * 2 + 7];
      buf[2] = buffer[offset * 2 + 4];
      buf[3] = buffer[offset * 2 + 5];
      buf[4] = buffer[offset * 2 + 2];
      buf[5] = buffer[offset * 2 + 3];
      buf[6] = buffer[offset * 2 + 0];
      buf[7] = buffer[offset * 2 + 1];
      return Number(buf.readBigUInt64BE())
    case 'uint64le':
      buf = Buffer.alloc(8);
      buf = buffer.subarray(offset * 2, offset * 2 + 8);
      buf.reverse();
      return Number(buf.readBigUInt64BE());
    case 'uint64sb':
      buf = Buffer.alloc(8);
      buf = buffer.subarray(offset * 2, offset * 2 + 8);
      buf.reverse();
      buf = reverseByte(buf);
      return Number(buf.readBigUInt64BE());
    case 'int64be':
      return Number(buffer.readBigInt64BE(offset * 2));
    case 'int64sw':
      buf = Buffer.alloc(8);
      //B7B8B5B6B3B4B1B2
      buf[0] = buffer[offset * 2 + 6];
      buf[1] = buffer[offset * 2 + 7];
      buf[2] = buffer[offset * 2 + 4];
      buf[3] = buffer[offset * 2 + 5];
      buf[4] = buffer[offset * 2 + 2];
      buf[5] = buffer[offset * 2 + 3];
      buf[6] = buffer[offset * 2 + 0];
      buf[7] = buffer[offset * 2 + 1];
      return Number(buf.readBigInt64BE());
    case 'int64le':
      return Number(buffer.readBigInt64LE(offset * 2));
    case 'int64sb':
      buf = Buffer.alloc(8);
      buf = buffer.subarray(offset * 2, offset * 2 + 8);
      buf.reverse();
      buf = reverseByte(buf);
      return Number(buf.readBigInt64BE());
    case 'floatbe':
      return buffer.readFloatBE(offset * 2);
    case 'floatle':
      return buffer.readFloatLE(offset * 2);
    case 'floatsw':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 2];
      buf[1] = buffer[offset * 2 + 3];
      buf[2] = buffer[offset * 2 + 0];
      buf[3] = buffer[offset * 2 + 1];
      return buf.readFloatBE(0);
    case 'floatsb':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 1];
      buf[1] = buffer[offset * 2 + 0];
      buf[2] = buffer[offset * 2 + 3];
      buf[3] = buffer[offset * 2 + 2];
      return buf.readFloatBE(0);
    case 'doublebe':
      return buffer.readDoubleBE(offset * 2);
    case 'doublele':
      return buffer.readDoubleLE(offset * 2);
    default:
      throw new Error(`Invalid type: ${vartype}`);
  }
}

function reverseByte(buf) {
  for (let i = 1; i < buf.length; i += 2) {
    [buf[i], buf[i - 1]] = [buf[i - 1], buf[i]];
  }
  return buf
}

function readValue(buffer, item) {
  let result = parseBufferRead(buffer, item);

  return processOneValue(result, item);
  // return item.usek ? transformHtoS(result, item) : result;
}

function processOneValue(result, item) {
  if (item.usek) return transformHtoS(result, item);
  if (item.bit) return extractBit(result, item.offset);
  return result;
}

function extractBit(val, offset) {
  return val & (1 << offset) ? 1 : 0;
}

function parseBufferRead(buffer, item) {
  let buf;
  let offset = Number(item.widx);
  let vartype = item.vartype;
  let strlength = Number(item.strlength);
  let index = 0;

  switch (vartype) {
    case 'bool':
      return getBitValue(buffer, offset);
    case 'uint8be':
      return buffer.readUInt8(offset * 2 + 1);
    case 'uint8le':
      return buffer.readUInt8(offset * 2);
    case 'int8be':
      return buffer.readInt8(offset * 2 + 1);
    case 'int8le':
      return buffer.readInt8(offset * 2);
    case 'uint16be':
      return buffer.readUInt16BE(offset * 2);
    case 'uint16le':
      return buffer.readUInt16LE(offset * 2);
    case 'int16be':
      return buffer.readInt16BE(offset * 2);
    case 'int16le':
      return buffer.readInt16LE(offset * 2);
    case 'uint32be':
      return buffer.readUInt32BE(offset * 2);
    case 'uint32le':
      return buffer.readUInt32LE(offset * 2);
    case 'uint32sw':
      // buf = new Buffer(4);
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 2];
      buf[1] = buffer[offset * 2 + 3];
      buf[2] = buffer[offset * 2 + 0];
      buf[3] = buffer[offset * 2 + 1];
      return buf.readUInt32BE(0);
    case 'uint32sb':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 1];
      buf[1] = buffer[offset * 2 + 0];
      buf[2] = buffer[offset * 2 + 3];
      buf[3] = buffer[offset * 2 + 2];
      return buf.readUInt32BE(0);
    case 'int32be':
      return buffer.readInt32BE(offset * 2);
    case 'int32le':
      return buffer.readInt32LE(offset * 2);
    case 'int32sw':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 2];
      buf[1] = buffer[offset * 2 + 3];
      buf[2] = buffer[offset * 2 + 0];
      buf[3] = buffer[offset * 2 + 1];
      return buf.readInt32BE(0);
    case 'int32sb':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 1];
      buf[1] = buffer[offset * 2 + 0];
      buf[2] = buffer[offset * 2 + 3];
      buf[3] = buffer[offset * 2 + 2];
      return buf.readInt32BE(0);
    case 'uint64be':
      return Number(buffer.readBigUInt64BE(offset * 2));
    case 'uint64sw':
      buf = Buffer.alloc(8);
      buf = buffer.subarray(offset * 2, offset * 2 + 8);
      buf = reverseByte(buf);
      return Number(buf.readBigUInt64BE());
    case 'uint64le':
      return Number(buffer.readBigUInt64LE(offset * 2));
    case 'uint64sb':
      buf = Buffer.alloc(8);
      buf = buffer.subarray(offset * 2, offset * 2 + 8);
      buf.reverse();
      buf = reverseByte(buf);
      return Number(buf.readBigUInt64BE());
    case 'int64be':
      return Number(buffer.readBigInt64BE(offset * 2));
    case 'int64sw':
      buf = Buffer.alloc(8);
      buf = buffer.subarray(offset * 2, offset * 2 + 8);
      buf = reverseByte(buf);
      return Number(buf.readBigInt64BE());
    case 'int64le':
      return Number(buffer.readBigInt64LE(offset * 2));
    case 'int64sb':
      buf = Buffer.alloc(8);
      buf = buffer.subarray(offset * 2, offset * 2 + 8);
      buf.reverse();
      buf = reverseByte(buf);
      return Number(buf.readBigInt64LE());
    case 'floatbe':
      return buffer.readFloatBE(offset * 2);
    case 'floatle':
      return buffer.readFloatLE(offset * 2);
    case 'floatsw':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 2];
      buf[1] = buffer[offset * 2 + 3];
      buf[2] = buffer[offset * 2 + 0];
      buf[3] = buffer[offset * 2 + 1];
      return buf.readFloatBE(0);
    case 'floatsb':
      buf = Buffer.alloc(4);
      buf[0] = buffer[offset * 2 + 1];
      buf[1] = buffer[offset * 2 + 0];
      buf[2] = buffer[offset * 2 + 3];
      buf[3] = buffer[offset * 2 + 2];
      return buf.readFloatBE(0);
    case 'doublebe':
      return buffer.readDoubleBE(offset * 2);
    case 'doublele':
      return buffer.readDoubleLE(offset * 2);
    case 'strasciibe':
      buf = Buffer.alloc(strlength);
      buf = buffer.toString('ascii', offset * 2, offset * 2 + strlength);
      return buf;
    case 'strasciisw':
      buf = Buffer.alloc(strlength);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength);
      buf = reverseByte(buf);
      buf = buf.toString('ascii');
      return buf;
    case 'strasciile':
      buf = Buffer.alloc(strlength);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength);
      return buf.reverse().toString('ascii');
    case 'strasciisb':
      buf = Buffer.alloc(strlength);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength);
      buf.reverse();
      buf = reverseByte(buf);
      buf = buf.toString('ascii');
      return buf;
    case 'strasciiwinbe':
      buf = Buffer.alloc(strlength);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength);
      index = buf.findIndex((item) => item == 0);
      return iconv.decode(buf.subarray(0, index), 'win1251');
    case 'strasciiwinsw':
      buf = Buffer.alloc(strlength);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength);
      buf = reverseByte(buf);
      index = buf.findIndex((item) => item == 0);
      return iconv.decode(buf.subarray(0, index), 'win1251');
    case 'strasciiwinle':
      buf = Buffer.alloc(strlength);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength);
      buf = buf.reverse()
      index = buf.findIndex((item) => item == 0);
      return iconv.decode(buf.subarray(0, index), 'win1251');
    case 'strasciiwinsb':
      buf = Buffer.alloc(strlength);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength);
      buf.reverse();
      buf = reverseByte(buf);
      index = buf.findIndex((item) => item == 0);
      return iconv.decode(buf.subarray(0, index), 'win1251');
    case 'strutf8be':
      buf = Buffer.alloc(strlength * 2);
      buf = buffer.toString('utf-8', offset * 2, offset * 2 + strlength * 2);
      return buf;
    case 'strutf8sw':
      buf = Buffer.alloc(strlength * 2);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength * 2);
      buf = reverseByte(buf);
      buf = buf.toString('utf-8');
      return buf;
    case 'strutf8le':
      buf = Buffer.alloc(strlength * 2);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength * 2);
      return buf.reverse().toString('utf-8');
    case 'strutf8sb':
      buf = Buffer.alloc(strlength * 2);
      buf = buffer.subarray(offset * 2, offset * 2 + strlength * 2);
      buf.reverse();
      buf = reverseByte(buf);
      buf = buf.toString('utf-8');
      return buf;
    default:
      throw new Error(`Invalid type: ${vartype}`);
  }
}

function parseBufferWrite(value, item) {
  let a0;
  let a1;
  let a2;
  let buffer;
  let vartype = item.vartype;
  let strbuf = Buffer.from(' ', 'ascii');
  let strlength = Number(item.strlength);

  switch (vartype) {
    case 'uint8be':
      buffer = Buffer.alloc(2);
      buffer[0] = 0;
      buffer.writeUInt8(value & 0xff, 1);
      break;
    case 'uint8le':
      buffer = Buffer.alloc(2);
      buffer[1] = 0;
      buffer.writeUInt8(value & 0xff, 0);
      break;
    case 'int8be':
      buffer = Buffer.alloc(2);
      buffer[0] = 0;
      buffer.writeInt8(value & 0xff, 1);
      break;
    case 'int8le':
      buffer = Buffer.alloc(2);
      buffer[1] = 0;
      buffer.writeInt8(value & 0xff, 0);
      break;
    case 'uint16be':
      buffer = Buffer.alloc(2);
      if (value > 65565) {
        console.log('TOO BIG NUMBER! ' + value);
      }
      buffer.writeUInt16BE(value, 0);
      break;
    case 'uint16le':
      buffer = Buffer.alloc(2);
      buffer.writeUInt16LE(value, 0);
      break;
    case 'int16be':
      // buffer = new Buffer(2);
      buffer = Buffer.alloc(2);
      buffer.writeInt16BE(value, 0);
      break;
    case 'int16le':
      buffer = Buffer.alloc(2);
      buffer.writeInt16LE(value, 0);
      break;
    case 'uint32be':
      buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(value, 0);
      break;
    case 'uint32le':
      buffer = Buffer.alloc(4);
      buffer.writeUInt32LE(value, 0);
      break;
    case 'uint32sw':
      buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(value, 0);
      a0 = buffer[0];
      a1 = buffer[1];
      buffer[0] = buffer[2];
      buffer[1] = buffer[3];
      buffer[2] = a0;
      buffer[3] = a1;
      break;
    case 'uint32sb':
      buffer = Buffer.alloc(4);
      buffer.writeUInt32BE(value, 0);
      a0 = buffer[0];
      a2 = buffer[2];
      buffer[0] = buffer[1];
      buffer[2] = buffer[3];
      buffer[1] = a0;
      buffer[3] = a2;
      break;
    case 'int32be':
      buffer = Buffer.alloc(4);
      buffer.writeInt32BE(value, 0);
      break;
    case 'int32le':
      buffer = Buffer.alloc(4);
      buffer.writeInt32LE(value, 0);
      break;
    case 'int32sw':
      buffer = Buffer.alloc(4);
      buffer.writeInt32BE(value, 0);
      a0 = buffer[0];
      a1 = buffer[1];
      buffer[0] = buffer[2];
      buffer[1] = buffer[3];
      buffer[2] = a0;
      buffer[3] = a1;
      break;
    case 'int32sb':
      buffer = Buffer.alloc(4);
      buffer.writeInt32BE(value, 0);
      a0 = buffer[0];
      a2 = buffer[2];
      buffer[0] = buffer[1];
      buffer[2] = buffer[3];
      buffer[1] = a0;
      buffer[3] = a2;
      break;
    case 'uint64be':
      buffer = Buffer.alloc(8);
      buffer.writeBigUInt64BE(BigInt(value), 0);
      break;
    case 'uint64le':
      buffer = Buffer.alloc(8);
      buffer.writeBigUInt64LE(BigInt(value), 0);
      break;
    case 'int64be':
      buffer = Buffer.alloc(8);
      buffer.writeBigInt64BE(BigInt(value), 0);
      break;
    case 'int64le':
      buffer = Buffer.alloc(8);
      buffer.writeBigInt64LE(BigInt(value), 0);
      break;
    case 'floatbe':
      buffer = Buffer.alloc(4);
      buffer.writeFloatBE(value, 0);
      break;
    case 'floatle':
      buffer = Buffer.alloc(4);
      buffer.writeFloatLE(value, 0);
      break;
    case 'floatsw':
      buffer = Buffer.alloc(4);
      buffer.writeFloatBE(value, 0);
      a0 = buffer[0];
      a1 = buffer[1];
      buffer[0] = buffer[2];
      buffer[1] = buffer[3];
      buffer[2] = a0;
      buffer[3] = a1;
      break;
    case 'floatsb':
      buffer = Buffer.alloc(4);
      buffer.writeFloatBE(value, 0);
      a0 = buffer[0];
      a2 = buffer[2];
      buffer[0] = buffer[1];
      buffer[2] = buffer[3];
      buffer[1] = a0;
      buffer[3] = a2;
      break;
    case 'doublebe':
      buffer = Buffer.alloc(8);
      buffer.writeDoubleBE(value, 0);
      break;
    case 'doublele':
      buffer = Buffer.alloc(8);
      buffer.writeDoubleLE(value, 0);
      break;
    case 'strasciibe':
      a0 = Buffer.from(value, 'ascii');
      if (a0.length % 2 == 1) {
        a0 = Buffer.concat([a0, strbuf]);
      }
      buffer = a0.subarray(0, strlength)
      break;
    case 'strasciisw':
      a0 = Buffer.from(value, 'ascii');
      if (a0.length % 2 == 1) {
        a0 = Buffer.concat([a0, strbuf]);
      }
      a0 = reverseByte(a0);
      buffer = a0.subarray(0, strlength)
      break;
    case 'strasciile':
      a0 = Buffer.from(value, 'ascii');
      a0 = a0.reverse();
      a1 = a0.subarray(0, strlength);
      if (a1.length % 2 == 1) {
        a1 = Buffer.concat([a1, strbuf]);
      }
      buffer = a1;
      break;
    case 'strasciisb':
      a0 = Buffer.from(value, 'ascii');
      a0.reverse();
      a1 = a0.subarray(0, strlength);
      if (a1.length % 2 == 1) {
        a1 = Buffer.concat([a1, strbuf]);
      }
      buffer = reverseByte(a1);
      break;
    case 'strasciiwinbe':
      a0 = iconv.encode(value, 'win1251');
      if (a0.length % 2 == 1) {
        a0 = Buffer.concat([a0, strbuf]);
      }
      buffer = a0.subarray(0, strlength)
      break;
    case 'strasciiwinsw':
      a0 = iconv.encode(value, 'win1251');
      if (a0.length % 2 == 1) {
        a0 = Buffer.concat([a0, strbuf]);
      }
      a0 = reverseByte(a0);
      buffer = a0.subarray(0, strlength)
      break;
    case 'strasciiwinle':
      a0 = iconv.encode(value, 'win1251');
      a0 = a0.reverse();
      a1 = a0.subarray(0, strlength);
      if (a1.length % 2 == 1) {
        a1 = Buffer.concat([a1, strbuf]);
      }
      buffer = a1;
      break;
    case 'strasciiwinsb':
      a0 = iconv.encode(value, 'win1251');
      a0.reverse();
      a1 = a0.subarray(0, strlength);
      if (a1.length % 2 == 1) {
        a1 = Buffer.concat([a1, strbuf]);
      }
      buffer = reverseByte(a1);
      break;
    case 'strutf8be':
      a0 = Buffer.from(value, 'utf-8');
      buffer = a0.subarray(0, strlength * 2);
      break;
    case 'strutf8sw':
      a0 = Buffer.from(value, 'utf-8');
      a0 = reverseByte(a0);
      buffer = a0.subarray(0, strlength * 2);
      break;
    case 'strutf8le':
      a0 = Buffer.from(value, 'utf-8');
      a1 = a0.subarray(0, strlength * 2);
      buffer = a1.reverse();
      break;
    case 'strutf8sb':
      a0 = Buffer.from(value, 'utf-8');
      a0.reverse();
      a0 = reverseByte(a0);
      buffer = a0.subarray(0, strlength * 2);
      break;
    case 'uintarray':
      buffer = Uint16Array.from(value);
      break;
    default:
      console.log(`Invalid type: ${vartype}  THROW`);
      throw new Error(`Invalid type: ${vartype}`);
  }
  return buffer;
}

function writeValue(buffer, item) {
  let val = item.usek ? transformStoH(buffer, item) : buffer;
  if (item.offset != undefined) {
    return val;
    // return parseBufferWrite(val, item);
  }
  return parseBufferWrite(val, item);
}

function writeValue1(buffer, item) {
  let val = item.usek ? transformStoH(buffer, item) : buffer;
  return parseBufferWrite(val, item);
}

function getBitValue(buffer, offset) {
  // Приходит упакованное побайтно
  // Переворачиваем буфер

  let i = Math.floor(offset / 8);
  let j = offset % 8;
  return buffer[i] & (1 << j) ? 1 : 0;
}

// Возвращает кол-во СЛОВ (word) или бит по типу переменной
function getVarLen(vartype, strlength) {
  switch (vartype) {
    case 'bool':
    case 'uint8be':
    case 'uint8le':
    case 'int8be':
    case 'int8le':
    case 'uint16be':
    case 'uint16le':
    case 'int16be':
    case 'int16le':
      return 1;

    case 'uint32be':
    case 'uint32le':
    case 'uint32sw':
    case 'uint32sb':
    case 'int32be':
    case 'int32le':
    case 'int32sw':
    case 'int32sb':
    case 'floatbe':
    case 'floatle':
    case 'floatsw':
    case 'floatsb':
      return 2;

    case 'int64be':
    case 'int64le':
    case 'int64sw':
    case 'int64sb':
    case 'uint64be':
    case 'uint64sw':
    case 'uint64sb':
    case 'uint64le':
    case 'doublebe':
    case 'doublele':
      return 4;

    case 'strasciibe':
    case 'strasciile':
    case 'strasciisw':
    case 'strasciisb':
    case 'strasciiwinbe':
    case 'strasciiwinle':
    case 'strasciiwinsw':
    case 'strasciiwinsb':
      return Math.ceil(strlength / 2);

    case 'strutf8be':
    case 'strutf8le':
    case 'strutf8sw':
    case 'strutf8sb':
      return strlength;

    default:
      throw new Error(`Invalid type: ${vartype}`);
  }
}

/** Функция сортировки используется в качестве вызываемой функции для сортировки массива ОБЪЕКТОВ
 *   arr.sort(byorder('place,room','D')
 *    @param {String}  ordernames - имена полей для сортировки через запятую
 *    @param {*}   direction: D-descending
 *
 * Возвращает функцию сравнения
 **/
function byorder(ordernames, direction, parsingInt) {
  var arrForSort = [];
  var dirflag = direction == 'D' ? -1 : 1; // ascending = 1, descending = -1;

  if (ordernames && typeof ordernames == 'string') {
    arrForSort = ordernames.split(',');
  }

  return function (o, p) {
    if (typeof o !== 'object' || typeof p !== 'object' || arrForSort.length === 0) {
      return 0;
    }

    for (let i = 0; i < arrForSort.length; i++) {
      let a;
      let b;
      let name = arrForSort[i];

      a = o[name];
      b = p[name];

      if (a !== b) {
        if (parsingInt) {
          let astr = String(a);
          let bstr = String(b);

          if (!isNaN(parseInt(astr, 10)) && !isNaN(parseInt(bstr, 10))) {
            return parseInt(astr, 10) < parseInt(bstr, 10) ? -1 * dirflag : 1 * dirflag;
          }
        }

        // сравним как числа
        if (!isNaN(Number(a)) && !isNaN(Number(b))) {
          return Number(a) < Number(b) ? -1 * dirflag : 1 * dirflag;
        }

        // одинаковый тип, не числа
        if (typeof a === typeof b) {
          return a < b ? -1 * dirflag : 1 * dirflag;
        }

        return typeof a < typeof b ? -1 * dirflag : 1 * dirflag;
      }
    }

    return 0;
  };
}

// При записи
function transformStoH(value, { ks0, ks, kh0, kh }) {
  value = parseInt(value);
  ks0 = parseInt(ks0) || 0;
  kh0 = parseInt(kh0) || 0;
  ks = ks != ks0 ? parseInt(ks) : ks0 + 1;
  kh = parseInt(kh);
  return kh != kh0 ? ((value - ks0) * (kh - kh0)) / (ks - ks0) + kh0 : kh;
}

// При чтении - коэф-ты уже обработаны
function transformHtoS(value, { ks0, ks, kh0, kh }) {
  let result = ((value - kh0) * (ks - ks0)) / (kh - kh0) + ks0;

  return result;
}

function getWriteRequests(channels, params) {
  if (!channels || !util.isArray(channels)) return [];

  let result = [];
  let maxReadLen;
  channels.sort(byorder('fcr,address'));

  const config = channels.filter(item => item.req);
  let i = 0;
  let current;
  let length;
  let nextaddress;

  while (i < config.length) {
    let item = config[i];
    if (item.fcr == 1 || item.fcr == 2) {
      maxReadLen = params.maxbitreadlen || 1000;
    } else {
      maxReadLen = params.maxreadlen || 125;
    }
    if (!current || isDiffWriteBlock(item, current, nextaddress) || getLengthAfterAdd(item, current) > maxReadLen) {
      // Записать предыдущий элемент
      if (current && length) {
        result.push(Object.assign({ length }, current));
      }
      length = 0;
      current = {
        desc: item.desc,
        nodeip: item.nodeip,
        nodeport: item.nodeport,
        nodetransport: item.nodetransport,
        unitid: item.unitid,
        address: item.address,
        bufdata: Buffer.alloc(0),
        ref: []
      };
    }

    length = getLengthAfterAdd(item, current);
    let refobj = getRefobj(item);
    refobj.widx = item.address - current.address;
    nextaddress = item.address + 1;


    current.ref.push(refobj);
    const writeValueBuf = writeValue1(item.value, item);
    try {
      current.bufdata = Buffer.concat([current.bufdata, writeValueBuf], current.bufdata.length + writeValueBuf.length);
    } catch (error) {
      this.plugin.log('Error ' + error);
    }
    i++;
  }

  if (current && length) {
    result.push(Object.assign({ length }, current));
  }
  return result;
}

function isDiffWriteBlock(citem, current, nextadr) {
  return citem.nodeip != current.nodeip || citem.nodeport != current.nodeport || citem.unitid != current.unitid || citem.fcr != current.fcr  || citem.address != nextadr;
}
