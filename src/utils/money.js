/**
 * src/utils/money.js
 * Money math in integer paise (never floating-point rupees) and payment term calculation.
 */

const toPaise = (rupees) => Math.round(Number(rupees) * 100);
const fromPaise = (paise) => Math.round(paise) / 100;

// "₹1,250" or "₹99.50"
const formatINR = (rupees) => {
  const value = Number(rupees);
  const hasPaise = Math.round(value * 100) % 100 !== 0;
  return `₹${value.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
};

/**
 * Booking total from quantity and unit price, rounded to paise.
 * @returns {number} rupees
 */
const bookingTotal = (quantity, unitPrice) => fromPaise(Math.round(Number(quantity) * toPaise(unitPrice)));

/**
 * How much the customer pays now, from the business's payment settings.
 *
 * @param {number} total  booking total in rupees
 * @param {{mode: 'full'|'advance', advanceType?: 'percentage'|'fixed', advanceValue?: number}} settings
 * @returns {{total: number, dueNow: number, remaining: number, mode: string,
 *            advanceType: string|null, advanceValue: number|null}}
 */
const calculatePaymentTerms = (total, settings) => {
  const totalPaise = toPaise(total);
  if (!Number.isFinite(totalPaise) || totalPaise <= 0) {
    throw new Error('Booking total must be greater than zero');
  }

  let duePaise = totalPaise;
  const mode = settings.mode === 'advance' ? 'advance' : 'full';
  let advanceType = null;
  let advanceValue = null;

  if (mode === 'advance') {
    advanceType = settings.advanceType;
    advanceValue = Number(settings.advanceValue);

    if (advanceType === 'percentage') {
      if (!(advanceValue > 0 && advanceValue <= 100)) throw new Error('Advance percentage must be between 0 and 100');
      duePaise = Math.round((totalPaise * advanceValue) / 100);
    } else if (advanceType === 'fixed') {
      if (!(advanceValue > 0)) throw new Error('Advance amount must be greater than zero');
      duePaise = toPaise(advanceValue);
    } else {
      throw new Error('Advance type must be percentage or fixed');
    }

    // Never ask for more than the booking total; Razorpay minimum is ₹1 (100 paise).
    duePaise = Math.min(Math.max(duePaise, 100), totalPaise);
  }

  return {
    mode,
    advanceType,
    advanceValue,
    total: fromPaise(totalPaise),
    dueNow: fromPaise(duePaise),
    remaining: fromPaise(totalPaise - duePaise),
  };
};

module.exports = { toPaise, fromPaise, formatINR, bookingTotal, calculatePaymentTerms };
