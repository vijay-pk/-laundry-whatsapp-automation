/**
 * src/config/businessKnowledge.js
 * Facts about the business, used by the AI assistant and the chat booking flow.
 *
 * This is the source of truth: if a past AI answer conflicts with this file,
 * this file wins. Correct wrong answers by editing here.
 *
 * Replace every value marked [EDIT] with your real business details.
 * Leave a field empty ('' or []) if unknown: the AI will then hand the
 * question to staff instead of guessing.
 */

const businessKnowledge = {
  name: '[EDIT] Your Laundry Name',
  description: 'Laundry and dry-cleaning service with doorstep pickup and delivery.',

  hours: '[EDIT] Mon-Sat 8:00 AM - 8:00 PM, Sunday closed',
  serviceArea: '[EDIT] Areas/pincodes where pickup and delivery are available',
  contactPhone: '[EDIT] +91 00000 00000',

  // Shown as the booking menu. `id` must stay stable (stored in chat sessions);
  // `name` max 24 characters (WhatsApp list row limit).
  // [EDIT] Prices are examples. Set real prices or remove lines.
  services: [
    { id: 'wash_fold', name: 'Wash & Fold', price: '[EDIT] ₹60 per kg', turnaround: '24-48 hours' },
    { id: 'wash_iron', name: 'Wash & Iron', price: '[EDIT] ₹90 per kg', turnaround: '48 hours' },
    { id: 'ironing', name: 'Ironing only', price: '[EDIT] ₹15 per piece', turnaround: '24 hours' },
    { id: 'dry_clean', name: 'Dry Cleaning', price: '[EDIT] from ₹150 per piece', turnaround: '3-4 days' },
  ],

  // Pickup windows offered in chat (24h "HH:MM", in the TIMEZONE env timezone).
  pickupSlots: [
    { start: '10:00', end: '12:00' },
    { start: '16:00', end: '18:00' },
  ],
  slotDaysAhead: 3,        // today + next N-1 days
  closedWeekdays: [0],     // 0 = Sunday ... 6 = Saturday
  minLeadMinutes: 60,      // a slot must start at least this far in the future

  policies: [
    '[EDIT] Free pickup and delivery on orders above ₹300.',
    'Bookings can be made, tracked, cancelled or rescheduled by replying on WhatsApp.',
    '[EDIT] Payment by UPI, card or cash on delivery.',
  ],
};

// Render the knowledge as plain text for the AI system prompt.
const toPromptText = (kb = businessKnowledge) => {
  const lines = [
    `Business: ${kb.name}`,
    `About: ${kb.description}`,
    kb.hours && `Opening hours: ${kb.hours}`,
    kb.serviceArea && `Service area: ${kb.serviceArea}`,
    kb.contactPhone && `Contact: ${kb.contactPhone}`,
  ];

  if (kb.services?.length) {
    lines.push('Services and prices:');
    kb.services.forEach((s) => lines.push(`- ${s.name}: ${s.price} (ready in ${s.turnaround})`));
  }

  if (kb.policies?.length) {
    lines.push('Policies:');
    kb.policies.forEach((p) => lines.push(`- ${p}`));
  }

  return lines.filter(Boolean).join('\n');
};

// Price list for customers.
const servicesText = (kb = businessKnowledge) =>
  ['Our services:', ...kb.services.map((s) => `• ${s.name}: ${s.price} (ready in ${s.turnaround})`)].join('\n');

module.exports = { businessKnowledge, toPromptText, servicesText };
