/**
 * Unit tests: src/channels/baileysFormat.js + src/config/messageTemplates.js
 * (QR-login WhatsApp: Cloud payloads <-> Baileys messages, no network)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { toOutbound, toCloudMessage, choiceMessage, phoneFromJid, createMenuMemory } = require('../../src/channels/baileysFormat');
const { templateText } = require('../../src/config/messageTemplates');

const PHONE = '919876543210';

describe('toOutbound', () => {
  it('sends text as is and forgets any menu', () => {
    assert.deepEqual(toOutbound({ to: PHONE, type: 'text', text: { body: 'Hello' } }), { text: 'Hello', options: null });
  });

  it('turns buttons into numbered options', () => {
    const out = toOutbound({
      to: PHONE,
      type: 'interactive',
      interactive: { type: 'button', body: { text: 'What next?' }, action: { buttons: [
        { type: 'reply', reply: { id: 'menu_book', title: 'Book pickup' } },
        { type: 'reply', reply: { id: 'menu_track', title: 'Track order' } },
      ] } },
    });
    assert.deepEqual(out.options, [{ id: 'menu_book', title: 'Book pickup' }, { id: 'menu_track', title: 'Track order' }]);
    assert.match(out.text, /^What next\?\n\n\*1\.\* Book pickup\n\*2\.\* Track order\n\n_Reply with a number\._$/);
  });

  it('turns list rows (with descriptions) into numbered options', () => {
    const out = toOutbound({
      to: PHONE,
      type: 'interactive',
      interactive: { type: 'list', body: { text: 'Pick a service' }, action: { button: 'Services', sections: [
        { title: 'Options', rows: [{ id: 'svc_wash_fold', title: 'Wash & Fold', description: '₹50 per kg' }] },
      ] } },
    });
    assert.deepEqual(out.options, [{ id: 'svc_wash_fold', title: 'Wash & Fold' }]);
    assert.match(out.text, /\*1\.\* Wash & Fold — ₹50 per kg/);
  });

  it('renders templates as text', () => {
    const out = toOutbound({
      to: PHONE,
      type: 'template',
      template: { name: 'laundry_booking_alert', language: { code: 'en_US' }, components: [
        { type: 'body', parameters: [{ type: 'text', text: 'Asha' }, { type: 'text', text: 'Wash & Fold' }, { type: 'text', text: 'Mon 10:00' }] },
      ] },
    });
    assert.equal(out.text, '🧺 New booking\nCustomer: Asha\nService: Wash & Fold\nPickup: Mon 10:00');
    assert.equal(out.options, null);
  });

  it('refuses WhatsApp Pay order_details (Cloud API only)', () => {
    assert.throws(
      () => toOutbound({ to: PHONE, type: 'interactive', interactive: { type: 'order_details' } }),
      { status: 501, message: /QR login/ }
    );
  });
});

describe('templateText', () => {
  it('fills known templates and the configured status template', () => {
    assert.match(templateText('booking_cancelled', ['Asha', 'Dry Cleaning']), /^Hi Asha, your Dry Cleaning booking has been cancelled/);
    process.env.TEMPLATE_ORDER_STATUS = 'order_update';
    try {
      assert.equal(templateText('order_update', ['Asha', 'Your order is ready.']), 'Hi Asha, Your order is ready.');
    } finally {
      delete process.env.TEMPLATE_ORDER_STATUS;
    }
  });

  it('falls back to the variables for unknown templates', () => {
    assert.equal(templateText('something_else', ['a', 'b']), 'a\nb');
  });
});

describe('toCloudMessage', () => {
  const msg = (message, key = {}) => ({
    key: { id: 'ABC123', remoteJid: `${PHONE}@s.whatsapp.net`, fromMe: false, ...key },
    message,
    pushName: ' Asha ',
    messageTimestamp: 1700000000,
  });

  it('converts plain and extended text', () => {
    assert.deepEqual(toCloudMessage(msg({ conversation: 'hi' })), {
      message: { id: 'bl_ABC123', from: PHONE, timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
      profileName: 'Asha',
    });
    assert.equal(toCloudMessage(msg({ extendedTextMessage: { text: 'book' } })).message.text.body, 'book');
  });

  it('unwraps disappearing messages', () => {
    assert.equal(toCloudMessage(msg({ ephemeralMessage: { message: { conversation: 'hello' } } })).message.text.body, 'hello');
  });

  it('converts a shared location', () => {
    const out = toCloudMessage(msg({ locationMessage: { degreesLatitude: 12.97, degreesLongitude: 77.59 } }));
    assert.equal(out.message.type, 'location');
    assert.deepEqual([out.message.location.latitude, out.message.location.longitude], [12.97, 77.59]);
  });

  it('reads the phone number from remoteJidAlt when the chat uses a LID', () => {
    const out = toCloudMessage(msg({ conversation: 'hi' }, { remoteJid: '123456789@lid', remoteJidAlt: `${PHONE}@s.whatsapp.net` }));
    assert.equal(out.message.from, PHONE);
    assert.equal(toCloudMessage(msg({ conversation: 'hi' }, { remoteJid: '123456789@lid' })), null, 'no phone known');
  });

  it('marks media so the app can answer "text only"', () => {
    assert.equal(toCloudMessage(msg({ imageMessage: {} })).message.type, 'image');
    assert.equal(toCloudMessage(msg({ audioMessage: {} })).message.type, 'audio');
  });

  it('ignores own, group, status and protocol messages', () => {
    assert.equal(toCloudMessage(msg({ conversation: 'x' }, { fromMe: true })), null);
    assert.equal(toCloudMessage(msg({ conversation: 'x' }, { remoteJid: '1203630@g.us' })), null);
    assert.equal(toCloudMessage(msg({ conversation: 'x' }, { remoteJid: 'status@broadcast' })), null);
    assert.equal(toCloudMessage(msg({ reactionMessage: { text: '👍' } })), null);
    assert.equal(toCloudMessage(msg({ protocolMessage: {} })), null);
  });

  it('phoneFromJid strips the device suffix', () => {
    assert.equal(phoneFromJid(`${PHONE}:12@s.whatsapp.net`), PHONE);
    assert.equal(phoneFromJid('abc@s.whatsapp.net'), null);
  });
});

describe('menu memory', () => {
  const options = [{ id: 'menu_book', title: 'Book pickup' }, { id: 'menu_track', title: 'Track order' }];

  it('maps a typed number or exact title to the option', () => {
    const menus = createMenuMemory();
    menus.remember(PHONE, options);
    assert.deepEqual(menus.resolve(PHONE, '2'), options[1]);
    assert.deepEqual(menus.resolve(PHONE, ' 1. '), options[0]);
    assert.deepEqual(menus.resolve(PHONE, 'book PICKUP'), options[0]);
    assert.equal(menus.resolve(PHONE, '3'), null, 'out of range');
    assert.equal(menus.resolve(PHONE, 'book'), null, 'free text stays text');
    assert.equal(menus.resolve('910000000001', '1'), null, 'per customer');
  });

  it('forgets the menu after a plain message (a later "5" is e.g. a quantity)', () => {
    const menus = createMenuMemory();
    menus.remember(PHONE, options);
    menus.remember(PHONE, null);
    assert.equal(menus.resolve(PHONE, '1'), null);
  });

  it('expires old menus', () => {
    let now = 0;
    const menus = createMenuMemory({ ttlMs: 1000, now: () => now });
    menus.remember(PHONE, options);
    now = 1001;
    assert.equal(menus.resolve(PHONE, '1'), null);
  });

  it('choiceMessage looks like a Cloud API list tap', () => {
    const tap = choiceMessage({ id: 'bl_1', from: PHONE, timestamp: '1' }, options[0]);
    assert.deepEqual(tap.interactive, { type: 'list_reply', list_reply: { id: 'menu_book', title: 'Book pickup' } });
    assert.equal(tap.type, 'interactive');
  });
});
