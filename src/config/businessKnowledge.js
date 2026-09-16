/**
 * src/config/businessKnowledge.js
 * Facts the AI assistant is allowed to use when answering customers.
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

  // [EDIT] Prices are examples. Set real prices or remove lines.
  services: [
    { name: 'Wash & Fold', price: '[EDIT] ₹60 per kg', turnaround: '24-48 hours' },
    { name: 'Wash & Iron', price: '[EDIT] ₹90 per kg', turnaround: '48 hours' },
    { name: 'Ironing only', price: '[EDIT] ₹15 per piece', turnaround: '24 hours' },
    { name: 'Dry Cleaning', price: '[EDIT] from ₹150 per piece', turnaround: '3-4 days' },
  ],

  policies: [
    '[EDIT] Free pickup and delivery on orders above ₹300.',
    'Bookings can be cancelled or rescheduled by replying on WhatsApp.',
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

module.exports = { businessKnowledge, toPromptText };
