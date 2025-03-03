const util = require("util");

// const plugin = require("ih-plugin-api")();
const app = require("./app");

(async () => {
 
  let plugin;
  try {
    const opt = getOptFromArgs();
    const pluginapi = opt && opt.pluginapi ? opt.pluginapi : 'ih-plugin-api';
    plugin = require(pluginapi+'/index.js')();
    
    plugin.log("Parallel Modbus plugin has started.", 1);
    plugin.params = await plugin.params.get();
    plugin.log('Received params...');
    plugin.log("Params:" + util.inspect(plugin.params), 1);
    await app(plugin);
  } catch (err) {
    plugin.exit(8, `Error! Message: ${util.inspect(err)}`);
  }
})();



function getOptFromArgs() {
  let opt;
  try {
    opt = JSON.parse(process.argv[2]); //
  } catch (e) {
    opt = {};
  }
  return opt;
}
