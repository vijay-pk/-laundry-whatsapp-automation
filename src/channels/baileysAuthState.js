/**
 * src/channels/baileysAuthState.js
 * Baileys auth state stored in Postgres (whatsapp_auth) instead of files,
 * so the QR login survives restarts and deploys on hosts with a wiped disk.
 * Same layout as Baileys' useMultiFileAuthState: 'creds' + '<type>-<id>' rows.
 */

const { readAuthRows, writeAuthRows, clearAuth } = require('../models/whatsappAuthModel');

/**
 * @param {{ BufferJSON: object, initAuthCreds: Function, proto: object }} baileys  pieces of the Baileys module
 * @param {object} [store] storage functions (tests inject fakes)
 * @returns {Promise<{ state: { creds: object, keys: object }, saveCreds: () => Promise<void>, clear: () => Promise<void> }>}
 */
const usePostgresAuthState = async ({ BufferJSON, initAuthCreds, proto }, store = { readAuthRows, writeAuthRows, clearAuth }) => {
  const encode = (value) => JSON.stringify(value, BufferJSON.replacer);
  const decode = (text) => JSON.parse(text, BufferJSON.reviver);

  const saved = (await store.readAuthRows(['creds'])).get('creds');
  const creds = saved ? decode(saved) : initAuthCreds();

  const keys = {
    get: async (type, ids) => {
      const rows = await store.readAuthRows(ids.map((id) => `${type}-${id}`));
      const data = {};
      ids.forEach((id) => {
        const text = rows.get(`${type}-${id}`);
        let value = text ? decode(text) : null;
        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
        data[id] = value;
      });
      return data;
    },
    set: async (data) => {
      const entries = [];
      Object.entries(data).forEach(([type, values]) =>
        Object.entries(values || {}).forEach(([id, value]) => entries.push([`${type}-${id}`, value ? encode(value) : null]))
      );
      await store.writeAuthRows(entries);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => store.writeAuthRows([['creds', encode(creds)]]),
    clear: () => store.clearAuth(),
  };
};

module.exports = { usePostgresAuthState };
