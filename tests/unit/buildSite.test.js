/**
 * Unit tests: scripts/buildSite.js (static website, no database needed)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildSite, findProblems, whatsappLink } = require('../../scripts/buildSite');
const { businessKnowledge } = require('../../src/config/businessKnowledge');

const KB = {
  ...businessKnowledge,
  name: 'Fresh & Clean <Laundry>',
  description: 'Doorstep laundry.',
  hours: 'Mon-Sat 8-8',
  serviceArea: 'Indiranagar, Koramangala',
  contactPhone: '+91 98765 43210',
  whatsappNumber: '919876543210',
  email: 'hello@fresh.test',
  address: '1 Main Road, Bengaluru 560001',
  services: [{ id: 'wash_fold', name: 'Wash & Fold', price: '₹50 per kg', unit: 'kg', unitPrice: 50, turnaround: '24 hours' }],
  policies: ['Free pickup above ₹300.'],
};

describe('buildSite', () => {
  let tmp;
  let publicDir;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-test-'));
    publicDir = path.join(tmp, 'public');
    fs.mkdirSync(publicDir);
    fs.writeFileSync(path.join(publicDir, 'styles.css'), 'body{}');
  });

  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

  it('builds home, privacy and 404 pages plus static assets', () => {
    const outDir = path.join(tmp, 'out1');
    const { files } = buildSite({ kb: KB, outDir, publicDir });
    assert.deepEqual(files, ['404.html', 'index.html', 'privacy.html', 'styles.css']);

    const home = read(outDir, 'index.html');
    assert.match(home, /href="https:\/\/wa\.me\/919876543210\?text=Hi"/);
    assert.match(home, /Wash &amp; Fold/);
    assert.match(home, /₹50 per kg/);
    assert.match(home, /10:00 – 12:00/, 'pickup slots from config');
    assert.match(home, /href="\/privacy"/);
    assert.doesNotMatch(home, /<script/i, 'no JavaScript on the site');
    assert.doesNotMatch(home, /whatsapp-qr\.png/, 'no QR section without the image');

    assert.match(read(outDir, 'privacy.html'), /mailto:hello@fresh\.test/);
  });

  it('escapes business values in HTML', () => {
    const outDir = path.join(tmp, 'out2');
    buildSite({ kb: KB, outDir, publicDir });
    const home = read(outDir, 'index.html');
    assert.match(home, /Fresh &amp; Clean &lt;Laundry&gt;/);
    assert.doesNotMatch(home, /<Laundry>/);
  });

  it('shows the WhatsApp QR code when site/public has whatsapp-qr.png', () => {
    const withQr = path.join(tmp, 'public-qr');
    fs.mkdirSync(withQr);
    fs.writeFileSync(path.join(withQr, 'whatsapp-qr.png'), 'png');
    const outDir = path.join(tmp, 'out3');
    buildSite({ kb: KB, outDir, publicDir: withQr });
    assert.match(read(outDir, 'index.html'), /<img src="\/whatsapp-qr\.png"/);
  });

  it('refuses to publish [EDIT] placeholders unless previewing', () => {
    const kb = { ...KB, name: '[EDIT] Your Laundry Name', services: [{ ...KB.services[0], price: '[EDIT] ₹50 per kg' }] };
    const outDir = path.join(tmp, 'out4');
    assert.throws(() => buildSite({ kb, outDir, publicDir }), /name still has \[EDIT\][\s\S]*services\[0\]\.price/);
    assert.equal(fs.existsSync(outDir), false, 'nothing written');

    const { problems } = buildSite({ kb, outDir, publicDir, allowPlaceholders: true });
    assert.equal(problems.length, 2);
    assert.doesNotMatch(read(outDir, 'index.html'), /\[EDIT\]/, 'preview hides the marker');
  });

  it('flags the shipped config and invalid WhatsApp numbers', () => {
    assert.ok(findProblems(businessKnowledge).length > 0, 'config still has [EDIT] values');
    assert.deepEqual(findProblems(KB), []);
    assert.match(findProblems({ ...KB, whatsappNumber: '+91 98765' }).join(), /digits only/);
  });

  it('builds wa.me links from any number format', () => {
    assert.equal(whatsappLink('+91 98765-43210', 'Book pickup'), 'https://wa.me/919876543210?text=Book%20pickup');
  });
});
