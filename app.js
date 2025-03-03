/**
 * app.js
 */
const util = require('util');
const tools = require('./tools');
const Client = require('./client');

module.exports = async function (plugin) {
  let clientArr = [];
  let params = plugin.params;
  let channels = [];
  let polls = [];
  try {
    channels = await plugin.channels.get();
    plugin.log('Received channels data: ' + util.inspect(channels), 2);
    await updateChannels(false);
  } catch (err) {
    plugin.log('err ' + err, 2)
    plugin.exit(2, 'Failed to get channels!');
  }
  plugin.channels.onChange(() => updateChannels(true));

  // TODO - нужно делить каналы по клиентам
  // пока все клиенты читают все каналы
  // Также непонятно, как быть при записи, можно
  // - писать в одном канале (firstClient)
  // - слушать здесь: plugin.onAct, затем писать в  qToWrite конкретного клиента
  // - перенести plugin.onAct в клиента, каждый клиент будет сам определять, его ли это адрес


  //plugin.log('maxreadtags ' + maxreadtags, 1);

  let i = 0;
  const polls_key_arr = Object.keys(polls)
  for (i=0; i< polls_key_arr.length; i++) {
    let item = polls[polls_key_arr[i]];
    try {
      let nextClient = new Client(plugin, params, i, {
        nodeip: item[0].nodeip,
        nodeport: item[0].nodeport,
        nodetransport: item[0].nodetransport,
      });
      clientArr[polls_key_arr[i]] = nextClient;
      nextClient.setPolls(item);
      nextClient.sendNext();
    } catch (e) {
      plugin.log('Client ' + i + ' error: ' + util.inspect(e), 1);
      //plugin.exit(1, "No connection")
    }
  }

  function terminatePlugin() {
    for (let i = 0; i < clientArr.length; i++) {
      if (clientArr[i] && clientArr[i].isOpen) clientArr[i].close();
    }
  }

  plugin.onCommand(message => {
    plugin.log('Get command ' + util.inspect(message), 1);
    if (message.command == 'readOnReq') {
      message.values = channels;
      clientArr[0].setRead(message);
    }
  });

  plugin.onAct(message => {
    plugin.log('ACT data=' + util.inspect(message.data), 1);
    const clientId = message.data[0].nodeip+":"+message.data[0].nodeport;
    // TODO - нужно распределить по клиентам??
    if (clientArr[clientId]) clientArr[clientId].setWrite(message.data);
    
  });

  async function updateChannels(getChannels) {

    if (getChannels === true) {
      plugin.log('Request updated channels', 1);
      channels = await plugin.channels.get();
      //this.terminatePlugin();
    }

    if (channels.length === 0) {
      plugin.log(`Channels do not exist!`, 1);
      terminatePlugin();
      process.exit(8);
    }

    channels.forEach(item => {
      item.nodeport = parseInt(item.nodeport);
      item.unitid = parseInt(item.unitid);
      item.address = parseInt(item.address);
      if (item.parentoffset) item.address += parseInt(item.parentoffset);
      item.vartype = item.manbo ? tools.getVartypeMan(item) : tools.getVartype(item.vartype, params);
    });

    const polls_arr = tools.getPolls(
      channels.filter(item => item.r),
      params
    );
    polls = groupedByIpPort(polls_arr);
    plugin.log(`Polls = ${util.inspect(polls, null, 4)}`, 2);

    //queue = tools.getPollArray(polls); // Очередь опроса -на чтение
    //qToWrite = []; // Очередь на запись - имеет более высокий приоритет
    //sendTime = 0;
  }

  function groupedByIpPort(data) {
    return data.reduce((acc, item) => {
      const key = `${item.nodeip}:${item.nodeport}`;

      if (!acc[key]) {
        acc[key] = [];
      }

      acc[key].push(item);

      return acc;
    }, {});
  }

  process.on('exit', terminatePlugin);
  process.on('SIGTERM', () => {
    process.exit(0);
  });
};
