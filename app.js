/**
 * app.js
 */
const util = require('util');
const tools = require('./tools');
const Client = require('./client');

module.exports = async function (plugin) {
  let clientArr = {};  // Объект для строковых ключей
  let params = plugin.params;
  let channels = [];
  let polls = [];
  let clientIndex = 0;  // Счетчик для новых клиентов (для логирования)

  try {
    channels = await plugin.channels.get();
    plugin.log('Received channels data: ' + util.inspect(channels), 2);
    await updateChannels(false);
  } catch (err) {
    plugin.log('err ' + err, 2);
    plugin.exit(2, 'Failed to get channels!');
  }
  plugin.channels.onChange(() => updateChannels(true));

  // TODO - нужно делить каналы по клиентам
  // пока все клиенты читают все каналы
  // Также непонятно, как быть при записи, можно
  // - писать в одном канале (firstClient)
  // - слушать здесь: plugin.onAct, затем писать в qToWrite конкретного клиента
  // - перенести plugin.onAct в клиента, каждый клиент будет сам определять, его ли это адрес

  function createOrUpdateClients() {
    const polls_key_arr = Object.keys(polls);
    for (let i = 0; i < polls_key_arr.length; i++) {
      const key = polls_key_arr[i];
      const item = polls[key];
      try {
        if (!clientArr[key]) {
          // Создаем новый клиент (при onChange все удалены)
          const nextClient = new Client(plugin, params, clientIndex++, {
            nodeip: item[0].nodeip,
            nodeport: item[0].nodeport,
            nodetransport: item[0].nodetransport,
          });
          clientArr[key] = nextClient;
          plugin.log(`Created client for ${key}`, 1);
        }
        // Устанавливаем опросы и перезапускаем
        clientArr[key].setPolls(item);
        clientArr[key].sendNext();
      } catch (e) {
        plugin.log('Client ' + key + ' error: ' + util.inspect(e), 1);
        // Продолжаем с другими, не выходим
      }
    }
    if (polls_key_arr.length === 0) {
      plugin.log('No polls after update, clients cleared', 1);
    }
  }

  async function terminatePlugin() {
  const numClients = Object.keys(clientArr).length;
  plugin.log(`Terminating ${numClients} clients`, 1);
  const promises = Object.values(clientArr).map(async (client) => {
    if (client) {
      await client.stop();  // Асинхронно останавливаем все
    }
  });
  await Promise.all(promises);  // Ждем завершения всех stop
  clientArr = {};  // Очищаем
}

  plugin.onCommand(message => {
    plugin.log('Get command ' + util.inspect(message), 1);
    if (message.command == 'readOnReq') {
      message.values = channels;
      const firstClient = Object.values(clientArr)[0];
      if (firstClient) {
        firstClient.setRead(message);
      } else {
        plugin.log('No clients available for readOnReq', 1);
      }
    }
  });

  plugin.onAct(message => {
    plugin.log('ACT data=' + util.inspect(message.data), 1);
    if (!message.data || message.data.length === 0) {
      plugin.log('Empty data in onAct', 1);
      return;
    }
    const clientId = message.data[0].nodeip + ":" + message.data[0].nodeport;
    if (clientArr[clientId]) {
      clientArr[clientId].setWrite(message.data);
    } else {
      plugin.log(`No client for ${clientId} in onAct`, 1);
    }
  });

  async function updateChannels(getChannels) {
    if (getChannels === true) {
      plugin.log('onChange: Terminating all clients before update', 1);
      terminatePlugin();  // Закрываем + очищаем, чтобы не дублировать подключения
    }

    if (getChannels === true) {
      plugin.log('Request updated channels', 1);
      try {
        channels = await plugin.channels.get();
        plugin.log('Updated channels: ' + util.inspect(channels), 1);
      } catch (err) {
        plugin.log('Error updating channels: ' + err, 1);
        return;  // Используем старые, не создаем клиентов
      }
    }

    if (channels.length === 0) {
      plugin.log(`Channels do not exist!`, 1);
      terminatePlugin();
      process.exit(8);
      return;
    }

    // Парсим каналы
    channels.forEach(item => {
      item.nodeport = parseInt(item.nodeport) || 0;
      item.unitid = parseInt(item.unitid) || 0;
      item.address = parseInt(item.address) || 0;
      if (item.parentoffset) {
        item.address += parseInt(item.parentoffset) || 0;
      }
      item.vartype = item.manbo ? tools.getVartypeMan(item) : tools.getVartype(item.vartype, params);
    });

    const polls_arr = tools.getPolls(
      channels.filter(item => item.r),
      params
    );
    polls = groupedByIpPort(polls_arr);
    plugin.log(`Polls updated = ${util.inspect(polls, null, 4)}`, 2);

    // Создаем/обновляем клиентов
    createOrUpdateClients();
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
    terminatePlugin();
    process.exit(0);
  });
};