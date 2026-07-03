import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import {
  LineChart, Line, BarChart, Bar, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer
} from "recharts";
import { db, auth } from "./firebase";
import { collection, getDocs, doc, getDoc, setDoc, deleteDoc } from "firebase/firestore";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";

/* ---------------- helpers ---------------- */

function letters(n) {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
}

// Formats a number with up to 2 decimal places, trailing zeros stripped.
// Uses Indian grouping. Returns "-" for null/undefined/NaN/0.
// Examples: 100 → "₹100", 100.5 → "₹100.5", 100.50 → "₹100.5", 100.567 → "₹100.57",
//           0.05 → "₹0.05", -50.5 → "(₹50.5)"
function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return "-";
  // Round to 2 decimal places to avoid float-noise like ₹100.00000000004
  const rounded = Math.round(Math.abs(n) * 100) / 100;
  if (rounded === 0) return "-";
  // Use maximumFractionDigits: 2 so trailing zeros are stripped automatically.
  const abs = rounded.toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return n < 0 ? `(₹${abs})` : `₹${abs}`;
}
// Like fmt but without the rupee symbol / negative parens, for use inside inputs.
// Same 2-decimal-max, trailing-zero-stripped behavior.
function fmtPlain(n) {
  if (n === null || n === undefined || isNaN(n)) return "";
  const rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString("en-IN", { maximumFractionDigits: 2 });
}
function num(v) {
  if (v === "" || v === null || v === undefined) return 0;
  const n = parseFloat(String(v).replace(/,/g, ""));
  return isNaN(n) ? 0 : n;
}
function monthLabel(key) {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}
function nextMonthKey(key) {
  let [y, m] = key.split("-").map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
function expenseStatus(budget, actual, hasActual) {
  if (!hasActual) return "Pending";
  if (budget > 0 && actual > budget) return "Over Budget";
  if (budget === 0 && actual === 0) return "Pending";
  return "On Track";
}
function ccStatus(due, paid, hasPaid) {
  if (!hasPaid || paid === 0) return due > 0 ? "Pending" : "-";
  if (paid > due) return "Overpaid";
  if (paid < due) return "Partial";
  return "Paid";
}
function investStatus(invested, currentValue, targetPct, stopPct) {
  if (!invested) return "-";
  const targetVal = invested * (1 + num(targetPct) / 100);
  const stopVal = invested * (1 - num(stopPct) / 100);
  if (num(targetPct) > 0 && currentValue >= targetVal) return "Target Hit";
  if (num(stopPct) > 0 && currentValue <= stopVal) return "Stop Loss Hit";
  return "Holding";
}
function badgeClass(status) {
  switch (status) {
    case "On Track": case "Paid": case "Target Hit": return "badge badge-green";
    case "Pending": case "Holding": return "badge badge-amber";
    case "Over Budget": case "Overpaid": case "Stop Loss Hit": return "badge badge-red";
    case "Partial": return "badge badge-amber";
    default: return "badge badge-gray";
  }
}

// Number of full months elapsed from startKey (inclusive) to currentKey (inclusive).
// e.g. start "2026-06", current "2026-06" → 1; current "2026-08" → 3.
function monthsElapsed(startKey, currentKey) {
  if (!startKey || !currentKey) return 0;
  const [sy, sm] = startKey.split("-").map(Number);
  const [cy, cm] = currentKey.split("-").map(Number);
  if (isNaN(sy) || isNaN(cy)) return 0;
  const diff = (cy - sy) * 12 + (cm - sm) + 1;
  return Math.max(0, diff);
}

// Generate a short unique ID for stable identity on Debt/Fixed rows.
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Get the stable ID for a debt (assigning one if missing — pure function, doesn't mutate).
// The wishlistItemId is used as a natural ID for wishlist-created debts so linked Fixed rows
// (which share wishlistItemId) auto-match without needing a migration step.
function debtIdOf(debt) {
  if (!debt) return null;
  return debt.id || debt.wishlistItemId || null;
}

// Count how many times a debt with the given id has been "paid" across allMonths up to
// and including currentKey. A payment counts when a Fixed Expense row has
// linkedDebtId === debtId AND paidMark === true. Wishlist-created Fixed rows automatically
// match via their wishlistItemId if no explicit linkedDebtId was set.
function countPaymentsForDebt(debtId, currentKey, allMonths) {
  if (!debtId || !allMonths) return 0;
  const sorted = [...allMonths].filter(m => m.key <= currentKey).sort((a, b) => a.key.localeCompare(b.key));
  let count = 0;
  for (const m of sorted) {
    for (const f of (m.fixed || [])) {
      if (!f.paidMark) continue;
      const fixedLinkId = f.linkedDebtId || f.wishlistItemId;
      if (fixedLinkId === debtId) count++;
    }
  }
  return count;
}

// Sum up manual/explicit payments applied to a debt via non-EMI Fixed rows.
// For debts without an emiPlan, each Paid? check reduces outstanding by the Fixed row's
// budget (or actual if entered). Returns the total to subtract.
function sumManualPaymentsForDebt(debtId, currentKey, allMonths) {
  if (!debtId || !allMonths) return 0;
  const sorted = [...allMonths].filter(m => m.key <= currentKey).sort((a, b) => a.key.localeCompare(b.key));
  let total = 0;
  for (const m of sorted) {
    for (const f of (m.fixed || [])) {
      if (!f.paidMark) continue;
      const fixedLinkId = f.linkedDebtId || f.wishlistItemId;
      if (fixedLinkId !== debtId) continue;
      // Use actual if entered, else budget
      const amt = f.actual !== null && f.actual !== undefined ? num(f.actual) : num(f.budget);
      total += amt;
    }
  }
  return total;
}

// Compute the remaining outstanding on a debt as of a given month.
// - If debt has an emiPlan: walk the amortization for each Paid? check on linked Fixed rows
// - If no emiPlan: start from debt.outstanding and subtract linked Paid? payments
// - allMonths is required to walk paid history; if missing, falls back to raw outstanding.
function effectiveOutstanding(debt, currentKey, allMonths) {
  if (!debt) return 0;
  if (!allMonths) return num(debt.outstanding);
  const debtId = debtIdOf(debt);
  const plan = debt.emiPlan;
  if (plan) {
    // Number of EMI payments actually made (Paid? checked) up to and including currentKey.
    const paymentsMade = debtId ? countPaymentsForDebt(debtId, currentKey, allMonths) : 0;
    const totalMonths = num(plan.totalMonths);
    if (paymentsMade <= 0) return num(plan.principal);
    if (paymentsMade >= totalMonths) return 0;
    const monthlyRate = num(plan.annualRate) / 100 / 12;
    const emi = num(plan.monthlyEmi);
    let remaining = num(plan.principal);
    for (let i = 0; i < paymentsMade; i++) {
      const interest = remaining * monthlyRate;
      const principalPayment = emi - interest;
      remaining -= principalPayment;
      if (remaining < 0) { remaining = 0; break; }
    }
    return Math.max(0, remaining);
  }
  // No EMI plan: raw outstanding minus any explicit linked payments.
  const raw = num(debt.outstanding);
  if (!debtId) return raw;
  const paid = sumManualPaymentsForDebt(debtId, currentKey, allMonths);
  return Math.max(0, raw - paid);
}

/* ---------------- seed / carry-forward ---------------- */

// Returns the current month key in YYYY-MM format, based on the local device date.
function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function seedMonth() {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return {
    key,
    income: { expected: null, actual: null },
    fixed: [
      { name: "Rent", budget: null, actual: null, paidMark: false },
      { name: "Groceries", budget: null, actual: null, paidMark: false }
    ],
    cc: [
      { name: "Card 1", due: null, paid: null, remarks: "", paidMark: false }
    ],
    variable: [
      { name: "Dining Out", budget: null, actual: null }
    ],
    debts: [],
    lent: [],
    investments: [],
    savingsBalance: { opening: 0, withdrawals: null }
  };
}

function buildNextMonth(prev, key, allMonths) {
  const prevComputed = computeMonth(prev, allMonths);
  return {
    key,
    income: { expected: prev.income.expected, actual: null },
    fixed: prev.fixed.map(r => ({
      name: r.name,
      budget: r.budget,
      actual: null,
      paidMark: false,
      ...(r.emiPlan ? { emiPlan: r.emiPlan } : {}),
      ...(r.wishlistItemId ? { wishlistItemId: r.wishlistItemId } : {}),
      ...(r.linkedDebtId ? { linkedDebtId: r.linkedDebtId } : {})
    })).filter(r => {
      // Drop Fixed EMI rows once they've been fully paid off.
      if (!r.emiPlan) return true;
      const paid = countPaymentsForDebt(r.linkedDebtId || r.wishlistItemId, key, allMonths);
      return paid < num(r.emiPlan.totalMonths);
    }),
    cc: prev.cc.map(r => ({ name: r.name, due: r.due, paid: null, remarks: "", paidMark: false })),
    variable: prev.variable.map(r => ({ name: r.name, budget: r.budget, actual: null })),
    debts: prev.debts.map(r => ({
      id: r.id || newId(),
      name: r.name,
      outstanding: r.outstanding,
      type: r.type || "interest-free",
      interestRate: r.interestRate ?? null,
      ...(r.emiPlan ? { emiPlan: r.emiPlan } : {}),
      ...(r.wishlistItemId ? { wishlistItemId: r.wishlistItemId } : {})
    })).filter(d => {
      // Drop debts that have been fully paid off (either EMI-complete or manually paid down to 0).
      return effectiveOutstanding(d, key, allMonths) > 0;
    }),
    lent: (prev.lent || []).map(r => ({ ...r })),
    investments: (prev.investments || []).map(r => ({ ...r })),
    savingsBalance: { opening: prevComputed.closingBalance, withdrawals: null }
  };
}

function computeMonth(m, allMonths) {
  const fixedBudget = m.fixed.reduce((s, r) => s + num(r.budget), 0);
  const fixedActual = m.fixed.reduce((s, r) => s + num(r.actual), 0);
  const ccDue = m.cc.reduce((s, r) => s + num(r.due), 0);
  const ccPaid = m.cc.reduce((s, r) => s + num(r.paid), 0);
  const varBudget = m.variable.reduce((s, r) => s + num(r.budget), 0);
  const varActual = m.variable.reduce((s, r) => s + num(r.actual), 0);
  const debtTotal = m.debts.reduce((s, r) => s + effectiveOutstanding(r, m.key, allMonths), 0);
  const expBudget = fixedBudget + ccDue + varBudget;
  const expActual = fixedActual + ccPaid + varActual;
  const incExpected = num(m.income.expected);
  const incActual = num(m.income.actual);
  const savingsExpected = incExpected - expBudget;
  const savingsActual = incActual - expActual;
  const rateExpected = incExpected > 0 ? (savingsExpected / incExpected) * 100 : 0;
  const rateActual = incActual > 0 ? (savingsActual / incActual) * 100 : 0;

  const sb = m.savingsBalance || { opening: 0, withdrawals: null };
  const openingBalance = num(sb.opening);
  const userWithdrawals = num(sb.withdrawals);
  const wishlistWithdrawals = (m.wishlistWithdrawals || []).reduce((s, w) => s + num(w.amount), 0);
  const withdrawals = userWithdrawals + wishlistWithdrawals;
  const computedClosing = openingBalance + savingsActual - withdrawals;
  // If user has entered an override (their real bank balance), use that as source of truth.
  // Override can be 0, so we check for null/undefined explicitly, not falsy.
  const hasOverride = sb.closingBalanceOverride !== null && sb.closingBalanceOverride !== undefined && sb.closingBalanceOverride !== "";
  const closingBalance = hasOverride ? num(sb.closingBalanceOverride) : computedClosing;

  const accItems = [...m.fixed, ...m.variable].filter(r => num(r.budget) > 0);
  let budgetAccuracy = null;
  if (accItems.length > 0) {
    const avgPct = accItems.reduce((s, r) => s + Math.abs(num(r.actual) - num(r.budget)) / num(r.budget), 0) / accItems.length;
    budgetAccuracy = Math.max(0, 100 - avgPct * 100);
  }

  const investments = m.investments || [];
  const investedTotal = investments.reduce((s, r) => s + num(r.invested), 0);
  const currentValueTotal = investments.reduce((s, r) => s + num(r.currentValue), 0);
  const investmentGain = currentValueTotal - investedTotal;
  const investmentGainPct = investedTotal > 0 ? (investmentGain / investedTotal) * 100 : 0;

  const lent = m.lent || [];
  const lentTotal = lent.reduce((s, r) => s + num(r.amount), 0);

  const netWorth = closingBalance + currentValueTotal + lentTotal - debtTotal;

  return {
    fixedBudget, fixedActual, ccDue, ccPaid, varBudget, varActual, debtTotal,
    expBudget, expActual, savingsExpected, savingsActual, rateExpected, rateActual,
    nonCardActual: fixedActual + varActual, nonCardBudget: fixedBudget + varBudget,
    openingBalance, withdrawals, closingBalance, computedClosing, hasOverride, budgetAccuracy,
    investedTotal, currentValueTotal, investmentGain, investmentGainPct,
    lentTotal, netWorth
  };
}

/* ---------------- Firestore storage ---------------- */

async function loadAllMonths() {
  try {
    const snap = await getDocs(collection(db, "months"));
    return snap.docs.map(d => d.data());
  } catch (e) { console.error("loadAllMonths failed", e); return []; }
}
async function saveMonthDoc(m) {
  try { await setDoc(doc(db, "months", m.key), m); } catch (e) { console.error("saveMonth failed", e); }
}
async function deleteMonthDoc(key) {
  try { await deleteDoc(doc(db, "months", key)); return true; } catch (e) { console.error("deleteMonth failed", e); return false; }
}
function defaultGoals() {
  return [
    { name: "", target: null, saved: null },
    { name: "", target: null, saved: null },
    { name: "", target: null, saved: null },
    { name: "", target: null, saved: null }
  ];
}
async function loadGoalsDoc() {
  try {
    const snap = await getDoc(doc(db, "settings", "goals"));
    return snap.exists() ? snap.data().goals : defaultGoals();
  } catch (e) { console.error("loadGoals failed", e); return defaultGoals(); }
}
async function saveGoalsDoc(goals) {
  try { await setDoc(doc(db, "settings", "goals"), { goals }); } catch (e) { console.error("saveGoals failed", e); }
}
async function loadWishlistDoc() {
  try {
    const snap = await getDoc(doc(db, "settings", "wishlist"));
    return snap.exists() ? (snap.data().items || []) : [];
  } catch (e) { console.error("loadWishlist failed", e); return []; }
}
async function saveWishlistDoc(items) {
  try { await setDoc(doc(db, "settings", "wishlist"), { items }); } catch (e) { console.error("saveWishlist failed", e); }
}

/* ---------------- small shared UI pieces ---------------- */

function Cell({ children, align = "left", strong = false, bg }) {
  return (
    <td className={`cell${strong ? " cell-strong" : ""}`} style={{ textAlign: align, background: bg }}>
      {children}
    </td>
  );
}
function EditText({ value, onChange, placeholder = "" }) {
  return (
    <input
      className="editin edit-text"
      type="text"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  );
}
// Sanitize a decimal input string: keep digits, one dot, and commas (we strip commas on parse).
// Returns the cleaned string (may end with a dot mid-typing, that's fine).
function sanitizeNumInput(s) {
  // Remove anything that isn't a digit, dot, or comma
  let cleaned = String(s).replace(/[^\d.,]/g, "");
  // Strip commas (Indian grouping) for parsing consistency
  cleaned = cleaned.replace(/,/g, "");
  // Keep only the first dot; subsequent dots are dropped
  const firstDot = cleaned.indexOf(".");
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, "");
  }
  return cleaned;
}

// Parse a sanitized string to a number, or null if empty / just a dot.
function parseNumInput(s) {
  if (s === "" || s === ".") return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function EditNum({ value, onChange }) {
  // Local buffer state so mid-typing values (like "100.") don't get overwritten by
  // fmtPlain(value) which would strip the trailing dot on every keystroke.
  const [buffer, setBuffer] = useState(null);
  const isFocused = buffer !== null;
  const display = isFocused ? buffer : (value === null || value === undefined ? "" : fmtPlain(value));

  return (
    <div className="numwrap">
      <span className="rupee">₹</span>
      <input
        className="editin edit-num"
        type="text"
        inputMode="decimal"
        value={display}
        placeholder="-"
        onFocus={() => setBuffer(value === null || value === undefined ? "" : String(value))}
        onBlur={() => setBuffer(null)}
        onChange={e => {
          const cleaned = sanitizeNumInput(e.target.value);
          setBuffer(cleaned);
          onChange(parseNumInput(cleaned));
        }}
      />
    </div>
  );
}

function EditPct({ value, onChange }) {
  const [buffer, setBuffer] = useState(null);
  const isFocused = buffer !== null;
  const display = isFocused ? buffer : (value === null || value === undefined ? "" : String(value));

  return (
    <div className="numwrap">
      <input
        className="editin edit-num"
        type="text"
        inputMode="decimal"
        value={display}
        placeholder="-"
        onFocus={() => setBuffer(value === null || value === undefined ? "" : String(value))}
        onBlur={() => setBuffer(null)}
        onChange={e => {
          const cleaned = sanitizeNumInput(e.target.value);
          setBuffer(cleaned);
          onChange(parseNumInput(cleaned));
        }}
      />
      <span className="pctsign">%</span>
    </div>
  );
}
function EditDate({ value, onChange }) {
  return (
    <input
      className="editin edit-date"
      type="date"
      value={value ?? ""}
      onChange={e => onChange(e.target.value)}
    />
  );
}
function SectionTitle({ title, span }) {
  rowCounter = 0;
  return (
    <tr className="section-row">
      <td className="rownum" />
      <td colSpan={span} className="section-title">{title}</td>
    </tr>
  );
}
function HeaderRow({ labels }) {
  return (
    <tr className="colhead-row">
      <td className="rownum" />
      {labels.map((l, i) => <td key={i} className="colhead">{l}</td>)}
    </tr>
  );
}

let rowCounter = 0;
function RowNum() {
  rowCounter += 1;
  return <td className="rownum">{rowCounter}</td>;
}

function SheetWrap({ cols, children }) {
  return (
    <div className="sheet-scroll">
      <table className="sheet">
        <thead>
          <tr className="letter-row">
            <td className="corner" />
            {letters(cols).map(l => <td key={l} className="letter">{l}</td>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/* ---------------- Expenses tab ---------------- */

function ExpensesTab({ month, setMonth, allMonths }) {
  rowCounter = 0;
  const c = computeMonth(month, allMonths);
  const [confirmClear, setConfirmClear] = useState(false);

  const update = (section, idx, field, value) => {
    setMonth(prev => ({ ...prev, [section]: prev[section].map((r, i) => i === idx ? { ...r, [field]: value } : r) }));
  };
  const addRow = (section, blank) => setMonth(prev => ({ ...prev, [section]: [...prev[section], blank] }));
  const removeRow = (section, idx) => setMonth(prev => ({ ...prev, [section]: prev[section].filter((_, i) => i !== idx) }));

  const clearActuals = () => {
    setMonth(prev => ({
      ...prev,
      fixed: (prev.fixed || []).map(r => ({ ...r, actual: null, paidMark: false })),
      cc: (prev.cc || []).map(r => ({ ...r, due: null, paid: null, paidMark: false })),
      variable: (prev.variable || []).map(r => ({ ...r, actual: null }))
    }));
    setConfirmClear(false);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button className="signoutbtn" onClick={() => setConfirmClear(true)} title="Clear actual amounts, paid marks, and card dues/paid for this month">
          Clear this month's actuals
        </button>
      </div>

      <SheetWrap cols={8}>
        <SectionTitle title="FIXED EXPENSES" span={8} />
        <HeaderRow labels={["Expense", "Budget (₹)", "Actual Paid (₹)", "Variance (₹)", "Status", "Paid?", "Linked debt", ""]} />
        {month.fixed.map((r, i) => {
          const hasActual = r.actual !== null && r.actual !== undefined;
          const variance = num(r.actual) - num(r.budget);
          const status = expenseStatus(num(r.budget), num(r.actual), hasActual);
          const paid = !!r.paidMark;
          const currentLink = r.linkedDebtId || r.wishlistItemId || "";
          const hasWishlistLock = !!r.wishlistItemId;
          return (
            <tr key={i} className={paid ? "paid-row" : undefined}>
              <RowNum />
              <Cell><EditText value={r.name} onChange={v => update("fixed", i, "name", v)} /></Cell>
              <Cell align="right"><EditNum value={r.budget} onChange={v => update("fixed", i, "budget", v)} /></Cell>
              <Cell align="right"><EditNum value={r.actual} onChange={v => update("fixed", i, "actual", v)} /></Cell>
              <Cell align="right">{fmt(variance)}</Cell>
              <Cell><span className={badgeClass(status)}>{status}</span></Cell>
              <Cell align="center"><input type="checkbox" className="paidmark" checked={paid} onChange={e => update("fixed", i, "paidMark", e.target.checked)} title="Mark as paid" /></Cell>
              <Cell>
                {hasWishlistLock ? (
                  <span className="muted" style={{ fontSize: 11 }} title="Managed by wishlist EMI plan">🔒 wishlist</span>
                ) : (month.debts || []).length === 0 ? (
                  <span className="muted" style={{ fontSize: 11 }}>—</span>
                ) : (
                  <select
                    className="debt-link-select"
                    value={currentLink}
                    onChange={e => update("fixed", i, "linkedDebtId", e.target.value || null)}
                    title="Link this expense to a debt row so paying it decrements the outstanding"
                  >
                    <option value="">(none)</option>
                    {(month.debts || []).map((d, di) => {
                      const dId = debtIdOf(d);
                      if (!dId) return null;
                      return <option key={dId} value={dId}>{d.name || `Debt ${di + 1}`}</option>;
                    })}
                  </select>
                )}
              </Cell>
              <Cell align="center"><button className="rowbtn" onClick={() => removeRow("fixed", i)}>×</button></Cell>
            </tr>
          );
        })}
        <tr className="total-row">
          <RowNum />
          <Cell strong>Total Fixed</Cell>
          <Cell align="right" strong>{fmt(c.fixedBudget)}</Cell>
          <Cell align="right" strong>{fmt(c.fixedActual)}</Cell>
          <Cell align="right" strong>{fmt(c.fixedActual - c.fixedBudget)}</Cell>
          <Cell /><Cell /><Cell />
          <Cell align="center"><button className="rowbtn addbtn" onClick={() => addRow("fixed", { name: "New expense", budget: null, actual: null, paidMark: false })}>+</button></Cell>
        </tr>

        <SectionTitle title="CREDIT CARD BILLS" span={8} />
        <HeaderRow labels={["Card", "Amount Due", "Paid", "Variance (₹)", "Status", "Paid?", "Remarks", ""]} />
        {month.cc.map((r, i) => {
          const hasPaid = r.paid !== null && r.paid !== undefined;
          const variance = num(r.paid) - num(r.due);
          const status = ccStatus(num(r.due), num(r.paid), hasPaid);
          const paid = !!r.paidMark;
          return (
            <tr key={i} className={paid ? "paid-row" : undefined}>
              <RowNum />
              <Cell><EditText value={r.name} onChange={v => update("cc", i, "name", v)} /></Cell>
              <Cell align="right"><EditNum value={r.due} onChange={v => update("cc", i, "due", v)} /></Cell>
              <Cell align="right"><EditNum value={r.paid} onChange={v => update("cc", i, "paid", v)} /></Cell>
              <Cell align="right">{fmt(variance)}</Cell>
              <Cell><span className={badgeClass(status)}>{status}</span></Cell>
              <Cell align="center"><input type="checkbox" className="paidmark" checked={paid} onChange={e => update("cc", i, "paidMark", e.target.checked)} title="Mark as paid" /></Cell>
              <Cell><EditText value={r.remarks} onChange={v => update("cc", i, "remarks", v)} /></Cell>
              <Cell align="center"><button className="rowbtn" onClick={() => removeRow("cc", i)}>×</button></Cell>
            </tr>
          );
        })}
        <tr className="total-row">
          <RowNum />
          <Cell strong>Total Credit Cards</Cell>
          <Cell align="right" strong>{fmt(c.ccDue)}</Cell>
          <Cell align="right" strong>{fmt(c.ccPaid)}</Cell>
          <Cell align="right" strong>{fmt(c.ccPaid - c.ccDue)}</Cell>
          <Cell /><Cell /><Cell />
          <Cell align="center"><button className="rowbtn addbtn" onClick={() => addRow("cc", { name: "New card", due: null, paid: null, remarks: "", paidMark: false })}>+</button></Cell>
        </tr>

        <SectionTitle title="VARIABLE EXPENSES" span={8} />
        <HeaderRow labels={["Expense", "Budget (₹)", "Actual Paid (₹)", "Remaining (₹)", "Variance (₹)", "Status", "", ""]} />
        {month.variable.map((r, i) => {
          const hasActual = r.actual !== null && r.actual !== undefined;
          const remaining = num(r.budget) - num(r.actual);
          const variance = num(r.actual) - num(r.budget);
          const status = expenseStatus(num(r.budget), num(r.actual), hasActual);
          return (
            <tr key={i}>
              <RowNum />
              <Cell><EditText value={r.name} onChange={v => update("variable", i, "name", v)} /></Cell>
              <Cell align="right"><EditNum value={r.budget} onChange={v => update("variable", i, "budget", v)} /></Cell>
              <Cell align="right"><EditNum value={r.actual} onChange={v => update("variable", i, "actual", v)} /></Cell>
              <Cell align="right">{fmt(remaining)}</Cell>
              <Cell align="right">{fmt(variance)}</Cell>
              <Cell><span className={badgeClass(status)}>{status}</span></Cell>
              <Cell />
              <Cell align="center"><button className="rowbtn" onClick={() => removeRow("variable", i)}>×</button></Cell>
            </tr>
          );
        })}
        <tr className="total-row">
          <RowNum />
          <Cell strong>Total Variable</Cell>
          <Cell align="right" strong>{fmt(c.varBudget)}</Cell>
          <Cell align="right" strong>{fmt(c.varActual)}</Cell>
          <Cell align="right" strong>{fmt(c.varBudget - c.varActual)}</Cell>
          <Cell align="right" strong>{fmt(c.varActual - c.varBudget)}</Cell>
          <Cell /><Cell />
          <Cell align="center"><button className="rowbtn addbtn" onClick={() => addRow("variable", { name: "New expense", budget: null, actual: null })}>+</button></Cell>
        </tr>

        <tr className="grand-total-row">
          <RowNum />
          <Cell strong>TOTAL EXPENSES</Cell>
          <Cell align="right" strong>{fmt(c.expBudget)}</Cell>
          <Cell align="right" strong>{fmt(c.expActual)}</Cell>
          <Cell align="right" strong>{fmt(c.expActual - c.expBudget)}</Cell>
          <Cell /><Cell /><Cell /><Cell />
        </tr>
      </SheetWrap>

      {confirmClear && (
        <div className="modal-backdrop" onClick={() => setConfirmClear(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Clear actuals for {monthLabel(month.key)}?</h3>
            <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-mid)" }}>
              This will clear:<br/>
              • Fixed Expenses — actual amounts and paid marks<br/>
              • Credit Cards — amount due, paid, and paid marks<br/>
              • Variable Expenses — actual amounts<br/><br/>
              Budgets, category names, and remarks stay. You can Undo (↶) after.
            </p>
            <div className="modal-actions">
              <button className="signoutbtn" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="savebtn" onClick={clearActuals}>Clear actuals</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Savings tab ---------------- */

function SavingsTab({ month, setMonth, allMonths }) {
  rowCounter = 0;
  const c = computeMonth(month, allMonths);
  const [confirmClear, setConfirmClear] = useState(false);
  const updateIncome = (field, value) => setMonth(prev => ({ ...prev, income: { ...prev.income, [field]: value } }));
  const updateSB = (field, value) => setMonth(prev => ({ ...prev, savingsBalance: { ...(prev.savingsBalance || { opening: 0, withdrawals: null }), [field]: value } }));

  const clearActuals = () => {
    setMonth(prev => ({
      ...prev,
      income: { ...(prev.income || { expected: null }), actual: null },
      savingsBalance: { ...(prev.savingsBalance || { opening: 0 }), withdrawals: null }
    }));
    setConfirmClear(false);
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button className="signoutbtn" onClick={() => setConfirmClear(true)} title="Clear actual income and withdrawals for this month">
          Clear this month's actuals
        </button>
      </div>

      <SheetWrap cols={4}>
        <SectionTitle title="INCOME & SAVINGS SUMMARY" span={4} />
        <HeaderRow labels={["", "Expected (₹)", "Actual (₹)", "Difference (₹)"]} />
        <tr>
          <RowNum />
          <Cell strong>Income</Cell>
          <Cell align="right"><EditNum value={month.income.expected} onChange={v => updateIncome("expected", v)} /></Cell>
          <Cell align="right"><EditNum value={month.income.actual} onChange={v => updateIncome("actual", v)} /></Cell>
          <Cell align="right">{fmt(num(month.income.actual) - num(month.income.expected))}</Cell>
        </tr>
        <tr>
          <RowNum />
          <Cell strong>Total Expenses</Cell>
          <Cell align="right">{fmt(c.expBudget)}</Cell>
          <Cell align="right">{fmt(c.expActual)}</Cell>
          <Cell align="right">{fmt(c.expActual - c.expBudget)}</Cell>
        </tr>
        <tr className="total-row">
          <RowNum />
          <Cell strong>Savings</Cell>
          <Cell align="right" strong>{fmt(c.savingsExpected)}</Cell>
          <Cell align="right" strong>{fmt(c.savingsActual)}</Cell>
          <Cell align="right" strong>{fmt(c.savingsActual - c.savingsExpected)}</Cell>
        </tr>
        <tr>
          <RowNum />
          <Cell strong>Savings Rate (%)</Cell>
          <Cell align="right">{c.rateExpected.toFixed(1)}%</Cell>
          <Cell align="right">{c.rateActual.toFixed(1)}%</Cell>
          <Cell align="right">{(c.rateActual - c.rateExpected).toFixed(1)}%</Cell>
        </tr>
        <tr>
          <RowNum />
          <Cell strong>Budget Accuracy (%)</Cell>
          <Cell align="right">-</Cell>
          <Cell align="right">{c.budgetAccuracy !== null ? c.budgetAccuracy.toFixed(1) + "%" : "-"}</Cell>
          <Cell />
        </tr>

        <SectionTitle title="SAVINGS BALANCE (ACTUAL AMOUNT LEFT)" span={4} />
        <HeaderRow labels={["", "Amount (₹)", "", ""]} />
        <tr>
          <RowNum />
          <Cell strong>Opening Balance</Cell>
          <Cell align="right"><EditNum value={month.savingsBalance?.opening} onChange={v => updateSB("opening", v)} /></Cell>
          <Cell /><Cell />
        </tr>
        <tr>
          <RowNum />
          <Cell strong>+ This Month's Savings</Cell>
          <Cell align="right">{fmt(c.savingsActual)}</Cell>
          <Cell /><Cell />
        </tr>
        <tr>
          <RowNum />
          <Cell strong>− Withdrawn / Dipped Into</Cell>
          <Cell align="right"><EditNum value={month.savingsBalance?.withdrawals} onChange={v => updateSB("withdrawals", v)} /></Cell>
          <Cell /><Cell />
        </tr>
        {(month.wishlistWithdrawals || []).length > 0 && (
          <tr>
            <RowNum />
            <Cell strong>− Wishlist-funded withdrawals</Cell>
            <Cell align="right">{fmt((month.wishlistWithdrawals || []).reduce((s, w) => s + num(w.amount), 0))}</Cell>
            <Cell colSpan={2}><span className="muted" style={{ fontSize: 11 }}>Auto-tracked from applied wishlist plans</span></Cell>
          </tr>
        )}
        <tr className="total-row">
          <RowNum />
          <Cell strong>Computed Closing Balance</Cell>
          <Cell align="right" strong>{fmt(c.computedClosing)}</Cell>
          <Cell colSpan={2}><span className="muted" style={{ fontSize: 11 }}>Opening + savings − withdrawals</span></Cell>
        </tr>
        <tr>
          <RowNum />
          <Cell strong>Actual Bank Balance (override)</Cell>
          <Cell align="right"><EditNum value={month.savingsBalance?.closingBalanceOverride} onChange={v => updateSB("closingBalanceOverride", v)} /></Cell>
          <Cell colSpan={2}><span className="muted" style={{ fontSize: 11 }}>Type your real bank balance here to override the computed value</span></Cell>
        </tr>
        <tr className="grand-total-row">
          <RowNum />
          <Cell strong>Closing Balance (used everywhere)</Cell>
          <Cell align="right" strong>{fmt(c.closingBalance)}</Cell>
          <Cell colSpan={2}>{c.hasOverride ? <span className="muted" style={{ fontSize: 11 }}>Using your override</span> : <span className="muted" style={{ fontSize: 11 }}>Using computed value</span>}</Cell>
        </tr>
      </SheetWrap>

      {confirmClear && (
        <div className="modal-backdrop" onClick={() => setConfirmClear(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Clear savings actuals for {monthLabel(month.key)}?</h3>
            <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-mid)" }}>
              This will clear:<br/>
              • Actual income for this month<br/>
              • Withdrawals from savings<br/><br/>
              Expected income and opening balance stay. Wishlist-funded withdrawals stay (unfund the item to reverse those). You can Undo (↶) after.
            </p>
            <div className="modal-actions">
              <button className="signoutbtn" onClick={() => setConfirmClear(false)}>Cancel</button>
              <button className="savebtn" onClick={clearActuals}>Clear actuals</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Debt tab ---------------- */

function DebtTab({ month, setMonth, allMonths }) {
  rowCounter = 0;
  const c = computeMonth(month, allMonths);

  // On mount: ensure every debt has a stable ID. If any are missing, save immediately.
  useEffect(() => {
    const anyMissing = (month.debts || []).some(d => !d.id && !d.wishlistItemId);
    if (anyMissing) {
      setMonth(prev => ({
        ...prev,
        debts: (prev.debts || []).map(d => (d.id || d.wishlistItemId) ? d : { ...d, id: newId() })
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (idx, field, value) => setMonth(prev => ({ ...prev, debts: prev.debts.map((r, i) => i === idx ? { ...r, [field]: value } : r) }));
  const addRow = () => setMonth(prev => ({ ...prev, debts: [...(prev.debts || []), { id: newId(), name: "New creditor", outstanding: null, type: "interest-free", interestRate: null }] }));
  const removeRow = idx => setMonth(prev => ({ ...prev, debts: prev.debts.filter((_, i) => i !== idx) }));

  // Auto-link: find Fixed rows without a link whose name matches a debt name, and connect them.
  // Retrofit for users with historical data. Operates only on the CURRENT month.
  const autoLink = () => {
    const debtsByName = {};
    (month.debts || []).forEach(d => {
      const key = (d.name || "").trim().toLowerCase();
      if (!key) return;
      const id = debtIdOf(d);
      if (!id) return;
      debtsByName[key] = id;
    });
    let linksApplied = 0;
    setMonth(prev => ({
      ...prev,
      fixed: (prev.fixed || []).map(f => {
        if (f.linkedDebtId || f.wishlistItemId) return f;
        const fkey = (f.name || "").trim().toLowerCase();
        // Try exact match, then contains
        let matchId = debtsByName[fkey];
        if (!matchId) {
          const partial = Object.keys(debtsByName).find(k => fkey.includes(k) || k.includes(fkey));
          if (partial) matchId = debtsByName[partial];
        }
        if (matchId) {
          linksApplied++;
          return { ...f, linkedDebtId: matchId };
        }
        return f;
      })
    }));
    setTimeout(() => alert(`Auto-linked ${linksApplied} Fixed Expense row${linksApplied === 1 ? "" : "s"} to matching debts.`), 50);
  };

  const totalInterestFree = (month.debts || []).filter(r => (r.type || "interest-free") === "interest-free").reduce((s, r) => s + effectiveOutstanding(r, month.key, allMonths), 0);
  const totalInterestBearing = (month.debts || []).filter(r => r.type === "interest-bearing").reduce((s, r) => s + effectiveOutstanding(r, month.key, allMonths), 0);
  const monthlyInterestCost = (month.debts || []).filter(r => r.type === "interest-bearing").reduce((s, r) => s + (effectiveOutstanding(r, month.key, allMonths) * num(r.interestRate) / 100 / 12), 0);

  // Build the last-12-months payment history for each debt.
  // For each debt, collect all Fixed row paid-marks across the last 12 months.
  const sortedAll = [...(allMonths || [])].sort((a, b) => a.key.localeCompare(b.key));
  const last12Months = sortedAll.slice(-12);
  const paymentHistory = {}; // { debtId: [{ monthKey, fixedName, amount }] }
  for (const m of last12Months) {
    for (const f of (m.fixed || [])) {
      if (!f.paidMark) continue;
      const linkId = f.linkedDebtId || f.wishlistItemId;
      if (!linkId) continue;
      const amt = f.actual !== null && f.actual !== undefined ? num(f.actual) : num(f.budget);
      if (!paymentHistory[linkId]) paymentHistory[linkId] = [];
      paymentHistory[linkId].push({ monthKey: m.key, fixedName: f.name || "Fixed expense", amount: amt });
    }
  }
  // Sort each debt's history newest-first
  for (const id of Object.keys(paymentHistory)) {
    paymentHistory[id].sort((a, b) => b.monthKey.localeCompare(a.monthKey));
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8, gap: 8 }}>
        <button className="signoutbtn" onClick={autoLink} title="Auto-link matching Fixed Expense rows to debts by name">
          Auto-link Fixed → Debts
        </button>
      </div>

      <SheetWrap cols={6}>
        <SectionTitle title="DEBT OUTSTANDING (WHAT I OWE)" span={6} />
        <HeaderRow labels={["Creditor", "Type", "Original (₹)", "Effective (₹)", "Interest Rate (% p.a.)", ""]} />
        {(month.debts || []).map((r, i) => {
          const type = r.type || "interest-free";
          const hasEmiPlan = !!r.emiPlan;
          const eff = effectiveOutstanding(r, month.key, allMonths);
          const debtId = debtIdOf(r);
          const originalAmount = hasEmiPlan ? num(r.emiPlan.principal) : num(r.outstanding);
          const paymentCount = paymentHistory[debtId]?.length || 0;
          return (
            <tr key={debtId || i}>
              <RowNum />
              <Cell><EditText value={r.name} onChange={v => update(i, "name", v)} /></Cell>
              <Cell>
                {hasEmiPlan ? (
                  <span className="muted" style={{ fontSize: 11 }}>EMI plan</span>
                ) : (
                  <select className="editin" value={type} onChange={e => update(i, "type", e.target.value)}>
                    <option value="interest-free">Interest-free</option>
                    <option value="interest-bearing">Interest-bearing</option>
                  </select>
                )}
              </Cell>
              <Cell align="right">
                {hasEmiPlan ? (
                  <span>{fmt(originalAmount)} <span className="muted" style={{ fontSize: 10 }}>auto</span></span>
                ) : (
                  <EditNum value={r.outstanding} onChange={v => update(i, "outstanding", v)} />
                )}
              </Cell>
              <Cell align="right">
                <span style={{ fontWeight: 500 }}>{fmt(eff)}</span>
                {paymentCount > 0 && (
                  <div className="muted" style={{ fontSize: 10 }}>{paymentCount} payment{paymentCount === 1 ? "" : "s"}</div>
                )}
              </Cell>
              <Cell align="right">
                {type === "interest-bearing"
                  ? (hasEmiPlan
                      ? <span>{num(r.interestRate).toFixed(1)}%</span>
                      : <EditPct value={r.interestRate} onChange={v => update(i, "interestRate", v)} />)
                  : <span className="muted">—</span>}
              </Cell>
              <Cell align="center">
                {hasEmiPlan ? (
                  <span className="muted" title="Managed by wishlist — Unfund the wishlist item to remove" style={{ fontSize: 11 }}>🔒</span>
                ) : (
                  <button className="rowbtn" onClick={() => removeRow(i)}>×</button>
                )}
              </Cell>
            </tr>
          );
        })}
        <tr className="total-row">
          <RowNum />
          <Cell strong>Interest-free total</Cell>
          <Cell /><Cell />
          <Cell align="right" strong>{fmt(totalInterestFree)}</Cell>
          <Cell /><Cell />
        </tr>
        <tr className="total-row">
          <RowNum />
          <Cell strong>Interest-bearing total</Cell>
          <Cell /><Cell />
          <Cell align="right" strong>{fmt(totalInterestBearing)}</Cell>
          <Cell align="right">≈ {fmt(monthlyInterestCost)}/mo interest</Cell>
          <Cell />
        </tr>
        <tr className="grand-total-row">
          <RowNum />
          <Cell strong>Total Debt (effective)</Cell>
          <Cell /><Cell />
          <Cell align="right" strong>{fmt(c.debtTotal)}</Cell>
          <Cell />
          <Cell align="center"><button className="rowbtn addbtn" onClick={addRow}>+</button></Cell>
        </tr>
      </SheetWrap>

      {(month.debts || []).length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div className="hist-heading">Payment history — last 12 months</div>
          {(month.debts || []).map((r, i) => {
            const debtId = debtIdOf(r);
            const history = paymentHistory[debtId] || [];
            const total = history.reduce((s, p) => s + p.amount, 0);
            return (
              <div key={debtId || i} className="payment-history-block">
                <div className="payment-history-head">
                  <span className="payment-history-name">{r.name || "Unnamed debt"}</span>
                  <span className="payment-history-total">
                    {history.length === 0 ? <span className="muted">No payments logged</span> :
                      <>{history.length} payment{history.length === 1 ? "" : "s"} · {fmt(total)}</>}
                  </span>
                </div>
                {history.length > 0 && (
                  <div className="payment-history-list">
                    {history.map((p, j) => (
                      <div key={j} className="payment-history-item">
                        <span className="payment-history-month">{monthLabel(p.monthKey)}</span>
                        <span className="payment-history-fixed">{p.fixedName}</span>
                        <span className="payment-history-amount">{fmt(p.amount)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <p className="muted" style={{ fontSize: 11, marginTop: 10 }}>
            Payments appear here when you mark a linked Fixed Expense row as Paid. Link Fixed rows to debts via the dropdown on the Expenses tab, or use "Auto-link Fixed → Debts" above.
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------------- Lent Out tab ---------------- */

function daysSince(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const diff = Date.now() - d.getTime();
  return Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
}
function ageLabel(days) {
  if (days === null) return "-";
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}
function ageBadgeClass(days) {
  if (days === null) return "badge badge-gray";
  if (days >= 180) return "badge badge-red";
  if (days >= 90) return "badge badge-amber";
  return "badge badge-green";
}

function LentTab({ month, setMonth, allMonths }) {
  rowCounter = 0;
  const c = computeMonth(month, allMonths);
  const lent = month.lent || [];
  const update = (idx, field, value) => setMonth(prev => ({ ...prev, lent: (prev.lent || []).map((r, i) => i === idx ? { ...r, [field]: value } : r) }));
  const addRow = () => setMonth(prev => ({ ...prev, lent: [...(prev.lent || []), { name: "", amount: null, date: "", note: "" }] }));
  const removeRow = idx => setMonth(prev => ({ ...prev, lent: (prev.lent || []).filter((_, i) => i !== idx) }));

  return (
    <SheetWrap cols={6}>
      <SectionTitle title="LENT OUT (WHAT OTHERS OWE ME)" span={6} />
      <HeaderRow labels={["Person", "Amount (₹)", "Date Lent", "Age", "Note", ""]} />
      {lent.length === 0 && (
        <tr>
          <RowNum />
          <Cell colSpan={5}><span className="muted">No entries yet — click + to add someone who owes you money.</span></Cell>
          <Cell align="center"><button className="rowbtn addbtn" onClick={addRow}>+</button></Cell>
        </tr>
      )}
      {lent.map((r, i) => {
        const age = daysSince(r.date);
        return (
          <tr key={i}>
            <RowNum />
            <Cell><EditText value={r.name} onChange={v => update(i, "name", v)} placeholder="Friend's name" /></Cell>
            <Cell align="right"><EditNum value={r.amount} onChange={v => update(i, "amount", v)} /></Cell>
            <Cell align="center"><EditDate value={r.date} onChange={v => update(i, "date", v)} /></Cell>
            <Cell><span className={ageBadgeClass(age)}>{ageLabel(age)}</span></Cell>
            <Cell><EditText value={r.note} onChange={v => update(i, "note", v)} placeholder="What was it for?" /></Cell>
            <Cell align="center"><button className="rowbtn" onClick={() => removeRow(i)}>×</button></Cell>
          </tr>
        );
      })}
      {lent.length > 0 && (
        <tr className="grand-total-row">
          <RowNum />
          <Cell strong>Total Lent Out</Cell>
          <Cell align="right" strong>{fmt(c.lentTotal)}</Cell>
          <Cell /><Cell /><Cell />
          <Cell align="center"><button className="rowbtn addbtn" onClick={addRow}>+</button></Cell>
        </tr>
      )}
    </SheetWrap>
  );
}

/* ---------------- Investments tab ---------------- */

function InvestmentsTab({ month, setMonth, allMonths }) {
  rowCounter = 0;
  const c = computeMonth(month, allMonths);
  const investments = month.investments || [];
  const update = (idx, field, value) => setMonth(prev => ({ ...prev, investments: (prev.investments || []).map((r, i) => i === idx ? { ...r, [field]: value } : r) }));
  const addRow = () => setMonth(prev => ({ ...prev, investments: [...(prev.investments || []), { name: "New holding", type: "Stocks", invested: null, date: "", currentValue: null, targetPct: null, stopPct: null }] }));
  const removeRow = idx => setMonth(prev => ({ ...prev, investments: (prev.investments || []).filter((_, i) => i !== idx) }));

  return (
    <SheetWrap cols={9}>
      <SectionTitle title="INVESTMENTS" span={9} />
      <HeaderRow labels={["Name", "Type", "Invested (₹)", "Date", "Current Value (₹)", "Target Profit (%)", "Stop Loss (%)", "Gain / Loss", "Status"]} />
      {investments.map((r, i) => {
        const invested = num(r.invested);
        const cur = num(r.currentValue);
        const gain = cur - invested;
        const gainPct = invested > 0 ? (gain / invested) * 100 : 0;
        const status = investStatus(invested, cur, r.targetPct, r.stopPct);
        return (
          <tr key={i}>
            <RowNum />
            <Cell><EditText value={r.name} onChange={v => update(i, "name", v)} /></Cell>
            <Cell><EditText value={r.type} onChange={v => update(i, "type", v)} placeholder="Stocks / Land / Gold…" /></Cell>
            <Cell align="right"><EditNum value={r.invested} onChange={v => update(i, "invested", v)} /></Cell>
            <Cell align="center"><EditDate value={r.date} onChange={v => update(i, "date", v)} /></Cell>
            <Cell align="right"><EditNum value={r.currentValue} onChange={v => update(i, "currentValue", v)} /></Cell>
            <Cell align="right"><EditPct value={r.targetPct} onChange={v => update(i, "targetPct", v)} /></Cell>
            <Cell align="right"><EditPct value={r.stopPct} onChange={v => update(i, "stopPct", v)} /></Cell>
            <Cell align="right">{invested > 0 ? `${fmt(gain)} (${gainPct.toFixed(1)}%)` : "-"}</Cell>
            <Cell><span className={badgeClass(status)}>{status}</span></Cell>
          </tr>
        );
      })}
      <tr className="total-row">
        <RowNum />
        <Cell strong>Total</Cell>
        <Cell />
        <Cell align="right" strong>{fmt(c.investedTotal)}</Cell>
        <Cell />
        <Cell align="right" strong>{fmt(c.currentValueTotal)}</Cell>
        <Cell /><Cell />
        <Cell align="right" strong>{c.investedTotal > 0 ? `${fmt(c.investmentGain)} (${c.investmentGainPct.toFixed(1)}%)` : "-"}</Cell>
        <Cell />
      </tr>
      <tr>
        <RowNum />
        <Cell colSpan={8}><button className="rowbtn addbtn" onClick={addRow}>+ Add holding</button></Cell>
      </tr>
    </SheetWrap>
  );
}

/* ---------------- Goals tab ---------------- */

function GoalsTab({ goals, setGoals, avgSavings, monthsCounted }) {
  rowCounter = 0;
  const update = (idx, field, value) => setGoals(prev => prev.map((g, i) => i === idx ? { ...g, [field]: value } : g));

  return (
    <div>
      <div className="goal-note">
        Predictions use your average actual savings over the last {monthsCounted} month{monthsCounted === 1 ? "" : "s"}
        {avgSavings !== null ? `: ${fmt(avgSavings)}/month.` : " — add more months of data for an estimate."}
      </div>
      <SheetWrap cols={6}>
        <SectionTitle title="SAVINGS GOALS" span={6} />
        <HeaderRow labels={["Goal", "Target (₹)", "Saved (₹)", "Remaining (₹)", "Progress", "Predicted completion"]} />
        {goals.map((g, i) => {
          const target = num(g.target);
          const saved = num(g.saved);
          const remaining = Math.max(0, target - saved);
          const progressPct = target > 0 ? Math.min(100, (saved / target) * 100) : 0;
          let predicted = "-";
          if (target > 0 && remaining === 0) predicted = "Achieved";
          else if (avgSavings !== null && avgSavings > 0 && remaining > 0) {
            const monthsNeeded = Math.ceil(remaining / avgSavings);
            const d = new Date();
            d.setMonth(d.getMonth() + monthsNeeded);
            predicted = `${monthsNeeded} mo — ${d.toLocaleDateString("en-IN", { month: "short", year: "numeric" })}`;
          } else if (remaining > 0) {
            predicted = "Not enough data";
          }
          return (
            <tr key={i}>
              <RowNum />
              <Cell><EditText value={g.name} onChange={v => update(i, "name", v)} placeholder={`Goal ${i + 1}`} /></Cell>
              <Cell align="right"><EditNum value={g.target} onChange={v => update(i, "target", v)} /></Cell>
              <Cell align="right"><EditNum value={g.saved} onChange={v => update(i, "saved", v)} /></Cell>
              <Cell align="right">{target > 0 ? fmt(remaining) : "-"}</Cell>
              <Cell>
                {target > 0 ? (
                  <div className="progress-track">
                    <div className="progress-fill" style={{ width: `${progressPct}%` }} />
                    <span className="progress-label">{progressPct.toFixed(0)}%</span>
                  </div>
                ) : "-"}
              </Cell>
              <Cell>{predicted}</Cell>
            </tr>
          );
        })}
      </SheetWrap>
    </div>
  );
}

/* ---------------- Home / Dashboard tab ---------------- */

function generateInsights(sortedMonths, goals, allMonths) {
  const insights = [];
  if (sortedMonths.length === 0) return insights;
  const last = sortedMonths[sortedMonths.length - 1];
  const lastC = computeMonth(last, allMonths);
  const prev = sortedMonths.length >= 2 ? sortedMonths[sortedMonths.length - 2] : null;
  const prevC = prev ? computeMonth(prev, allMonths) : null;

  // Savings change vs previous month
  if (prevC && lastC.savingsActual !== 0) {
    const diff = lastC.savingsActual - prevC.savingsActual;
    const pct = prevC.savingsActual !== 0 ? (diff / Math.abs(prevC.savingsActual)) * 100 : 0;
    if (Math.abs(pct) >= 10) {
      insights.push({
        tone: diff >= 0 ? "good" : "warn",
        text: `Savings ${diff >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(0)}% vs last month (${fmt(diff)}).`
      });
    }
  }

  // Card spend change
  if (prevC && prevC.ccPaid > 0) {
    const diff = lastC.ccPaid - prevC.ccPaid;
    const pct = (diff / prevC.ccPaid) * 100;
    if (Math.abs(pct) >= 15) {
      insights.push({
        tone: diff > 0 ? "warn" : "good",
        text: `Card spend ${diff > 0 ? "up" : "down"} ${Math.abs(pct).toFixed(0)}% vs last month.`
      });
    }
  }

  // Over-budget categories this month
  const overBudget = [...(last.fixed || []), ...(last.variable || [])].filter(r => num(r.budget) > 0 && num(r.actual) > num(r.budget));
  if (overBudget.length > 0) {
    const biggest = overBudget.reduce((max, r) => (num(r.actual) - num(r.budget)) > (num(max.actual) - num(max.budget)) ? r : max, overBudget[0]);
    insights.push({
      tone: "warn",
      text: `${biggest.name} is over budget by ${fmt(num(biggest.actual) - num(biggest.budget))}.`
    });
  }

  // Unpaid credit cards
  const unpaidCards = (last.cc || []).filter(r => num(r.due) > 0 && !num(r.paid));
  if (unpaidCards.length > 0) {
    insights.push({
      tone: "warn",
      text: `${unpaidCards.length} unpaid card${unpaidCards.length > 1 ? "s" : ""}: ${unpaidCards.map(c => c.name).join(", ")}.`
    });
  }

  // Old lent-out entries
  const oldLent = (last.lent || []).filter(r => {
    const age = daysSince(r.date);
    return age !== null && age >= 90 && num(r.amount) > 0;
  });
  if (oldLent.length > 0) {
    const oldest = oldLent.reduce((max, r) => daysSince(r.date) > daysSince(max.date) ? r : max, oldLent[0]);
    insights.push({
      tone: "warn",
      text: `${oldest.name || "Someone"} owes you ${fmt(num(oldest.amount))} — outstanding for ${ageLabel(daysSince(oldest.date))}.`
    });
  }

  // Investment status hits
  const targetHits = (last.investments || []).filter(r => investStatus(num(r.invested), num(r.currentValue), r.targetPct, r.stopPct) === "Target Hit");
  const stopHits = (last.investments || []).filter(r => investStatus(num(r.invested), num(r.currentValue), r.targetPct, r.stopPct) === "Stop Loss Hit");
  if (targetHits.length > 0) {
    insights.push({ tone: "good", text: `${targetHits.map(r => r.name).join(", ")} hit your profit target — consider booking.` });
  }
  if (stopHits.length > 0) {
    insights.push({ tone: "warn", text: `${stopHits.map(r => r.name).join(", ")} hit stop-loss — review your position.` });
  }

  // Goal progress
  const active = goals.filter(g => num(g.target) > 0);
  if (active.length > 0) {
    const closest = active.reduce((best, g) => {
      const bp = num(best.saved) / num(best.target);
      const gp = num(g.saved) / num(g.target);
      return gp > bp && gp < 1 ? g : best;
    });
    const pct = (num(closest.saved) / num(closest.target)) * 100;
    if (pct >= 75 && pct < 100) {
      insights.push({ tone: "good", text: `${closest.name || "Nearest goal"} is ${pct.toFixed(0)}% funded — you're close.` });
    }
  }

  return insights;
}

function HomeTab({ month, allMonths, goals, wishlist, onGo }) {
  const sorted = [...allMonths].sort((a, b) => a.key.localeCompare(b.key));
  if (sorted.length === 0 || !month) {
    return <div className="empty-state">No data yet. Start filling in the Expenses tab.</div>;
  }
  // Use the currently-SELECTED month for stats, not sorted[last].
  // sorted[last] would pick up empty future placeholder months and poison the dashboard.
  const last = month;
  const c = computeMonth(last, allMonths);

  // Net worth trend: still uses all months chronologically
  const netWorthSeries = sorted.map(m => {
    const cc = computeMonth(m, allMonths);
    return { month: monthLabel(m.key), netWorth: cc.netWorth };
  });
  // "vs last month" compares to the month with the immediately-previous key that exists.
  const currentIdx = sorted.findIndex(m => m.key === last.key);
  const prevMonth = currentIdx > 0 ? sorted[currentIdx - 1] : null;
  const prev = prevMonth ? computeMonth(prevMonth, allMonths) : null;
  const nwChange = prev ? c.netWorth - prev.netWorth : null;

  // Nearest goal
  const activeGoals = goals.filter(g => num(g.target) > 0);
  const nearestGoal = activeGoals.length > 0
    ? activeGoals.reduce((best, g) => {
        const bp = num(best.saved) / num(best.target);
        const gp = num(g.saved) / num(g.target);
        return gp > bp ? g : best;
      })
    : null;

  // Oldest lent
  const lentEntries = (last.lent || []).filter(r => num(r.amount) > 0);
  const oldestLent = lentEntries.length > 0
    ? lentEntries.reduce((oldest, r) => {
        const a = daysSince(r.date) ?? 0;
        const b = daysSince(oldest.date) ?? 0;
        return a > b ? r : oldest;
      })
    : null;

  const insights = generateInsights(sorted, goals, allMonths);

  // Detect whether this month has any meaningful data at all
  const monthIsEmpty = (last.debts || []).length === 0
    && (last.lent || []).length === 0
    && (last.investments || []).length === 0
    && num(last.income?.actual) === 0
    && num(last.income?.expected) === 0
    && (last.fixed || []).every(r => !num(r.actual) && !num(r.budget))
    && (last.variable || []).every(r => !num(r.actual) && !num(r.budget))
    && (last.cc || []).every(r => !num(r.due) && !num(r.paid))
    && !c.hasOverride;


  return (
    <div className="history">
      <div className="home-month-header">
        <span>Showing <b>{monthLabel(last.key)}</b></span>
        {monthIsEmpty && (
          <span className="empty-month-badge">This month has no data entered</span>
        )}
      </div>
      {monthIsEmpty && (
        <div className="empty-month-warning">
          ⚠ This month is empty. Switch to a month with data using the month selector at the top, or start entering values in the Expenses/Savings tabs.
        </div>
      )}
      <div className="stat-cards">
        <div className="stat-card stat-hero" onClick={() => onGo("history")}>
          <div className="stat-label">Net Worth</div>
          <div className={"stat-value-big " + (c.netWorth >= 0 ? "pos" : "neg")}>{fmt(c.netWorth)}</div>
          {nwChange !== null && (
            <div className={"stat-sub " + (nwChange >= 0 ? "pos" : "neg")}>
              {nwChange >= 0 ? "▲" : "▼"} {fmt(Math.abs(nwChange))} vs last month
            </div>
          )}
        </div>
        <div className="stat-card" onClick={() => onGo("savings")}>
          <div className="stat-label">Savings Balance{c.hasOverride ? " (override)" : ""}</div>
          <div className="stat-value">{fmt(c.closingBalance)}</div>
          <div className="stat-sub">This month: {fmt(c.savingsActual)}</div>
        </div>
        <div className="stat-card" onClick={() => onGo("investments")}>
          <div className="stat-label">Investments</div>
          <div className="stat-value">{fmt(c.currentValueTotal)}</div>
          <div className={"stat-sub " + (c.investmentGain >= 0 ? "pos" : "neg")}>
            {c.investedTotal > 0 ? `${c.investmentGain >= 0 ? "+" : ""}${c.investmentGainPct.toFixed(1)}% overall` : "No holdings"}
          </div>
        </div>
        <div className="stat-card" onClick={() => onGo("lent")}>
          <div className="stat-label">Lent Out</div>
          <div className="stat-value">{fmt(c.lentTotal)}</div>
          <div className="stat-sub">
            {oldestLent ? `Oldest: ${oldestLent.name || "?"}, ${ageLabel(daysSince(oldestLent.date))}` : "Nothing outstanding"}
          </div>
        </div>
        <div className="stat-card" onClick={() => onGo("debt")}>
          <div className="stat-label">Debt</div>
          <div className={"stat-value " + (c.debtTotal > 0 ? "neg" : "")}>{fmt(c.debtTotal)}</div>
        </div>
        <div className="stat-card" onClick={() => onGo("goals")}>
          <div className="stat-label">Nearest Goal</div>
          {nearestGoal ? (
            <>
              <div className="stat-value" style={{ fontSize: 15 }}>{nearestGoal.name || "Unnamed goal"}</div>
              <div className="stat-sub">
                {((num(nearestGoal.saved) / num(nearestGoal.target)) * 100).toFixed(0)}% funded
              </div>
            </>
          ) : (
            <div className="stat-sub">No goals set</div>
          )}
        </div>
        {(() => {
          const pending = (wishlist || []).filter(x => x.status !== "funded");
          const topPending = pending.length > 0
            ? pending.reduce((best, x) => {
                const pOrder = { Critical: 3, High: 2, Medium: 1, Low: 0 };
                return (pOrder[x.priority] ?? 0) > (pOrder[best.priority] ?? 0) ? x : best;
              })
            : null;
          return (
            <div className="stat-card" onClick={() => onGo("wishlist")}>
              <div className="stat-label">Wishlist</div>
              {topPending ? (
                <>
                  <div className="stat-value" style={{ fontSize: 15 }}>{topPending.name || "Unnamed item"}</div>
                  <div className="stat-sub">{fmt(num(topPending.cost))} · {topPending.priority}</div>
                </>
              ) : (
                <div className="stat-sub">Nothing pending</div>
              )}
            </div>
          );
        })()}
      </div>

      {insights.length > 0 && (
        <>
          <h3 className="hist-heading">This month</h3>
          <div className="insights-list">
            {insights.map((ins, i) => (
              <div key={i} className={"insight insight-" + ins.tone}>
                <span className="insight-dot" />
                <span>{ins.text}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Diagnostic panel — shows the exact inputs feeding Net Worth so users can spot missing data */}
      <h3 className="hist-heading">Net Worth breakdown ({monthLabel(last.key)})</h3>
      <div className="diagnostic-panel">
        <div className="diagnostic-row">
          <span className="k">Closing balance {c.hasOverride ? "(override)" : "(computed)"}</span>
          <span className="v">{fmt(c.closingBalance)}</span>
        </div>
        {!c.hasOverride && (
          <>
            <div className="diagnostic-row">
              <span className="k">&nbsp;&nbsp;Opening balance</span>
              <span className="v">{fmt(c.openingBalance)}</span>
            </div>
            <div className="diagnostic-row">
              <span className="k">&nbsp;&nbsp;+ This month's savings (income − expenses)</span>
              <span className="v" style={{ color: c.savingsActual < 0 ? "var(--neg)" : undefined }}>{fmt(c.savingsActual)}</span>
            </div>
            <div className="diagnostic-row">
              <span className="k">&nbsp;&nbsp;− Withdrawals</span>
              <span className="v">{fmt(c.withdrawals)}</span>
            </div>
          </>
        )}
        <div className="diagnostic-row">
          <span className="k">+ Investments (current value)</span>
          <span className="v">{fmt(c.currentValueTotal)}</span>
        </div>
        <div className="diagnostic-row">
          <span className="k">+ Lent out</span>
          <span className="v">{fmt(c.lentTotal)}</span>
        </div>
        <div className="diagnostic-row">
          <span className="k">− Debt outstanding (effective)</span>
          <span className="v" style={{ color: c.debtTotal > 0 ? "var(--neg)" : undefined }}>{fmt(c.debtTotal)}</span>
        </div>
        <div className="diagnostic-row" style={{ paddingTop: 6, borderTop: "1px solid var(--border)", marginTop: 6 }}>
          <span className="k" style={{ fontWeight: 500, color: "var(--text)" }}>= Net Worth</span>
          <span className="v" style={{ fontWeight: 500, color: c.netWorth >= 0 ? "var(--pos)" : "var(--neg)" }}>{fmt(c.netWorth)}</span>
        </div>

        {/* Warnings when suspicious things detected */}
        {(last.debts || []).length > 0 && c.debtTotal === 0 && (
          <div className="diagnostic-warn">
            ⚠ You have {(last.debts || []).length} debt row{(last.debts || []).length === 1 ? "" : "s"} but total effective debt is ₹0. Either all debts are fully paid off, or the Outstanding amounts are blank on the Debt tab.
          </div>
        )}
        {(last.debts || []).length === 0 && (
          <div className="diagnostic-warn">
            ⚠ No debt rows on this month. If you have credit card balances or loans, add them on the Debt tab so Net Worth reflects them.
          </div>
        )}
        {!c.hasOverride && num(last.income?.actual) === 0 && c.expActual > 0 && (
          <div className="diagnostic-warn">
            ⚠ Income actual is blank but you've entered ₹{fmtPlain(c.expActual)} of expenses. The computed closing balance will be too low. Either enter this month's actual income (Savings tab) or use the "Actual Bank Balance" override.
          </div>
        )}
        {!c.hasOverride && c.openingBalance === 0 && sorted.length > 1 && (
          <div className="diagnostic-warn">
            ⚠ Opening balance is ₹0. If this is your first month in the app, enter your real starting savings on the Savings tab. Otherwise Net Worth will drift.
          </div>
        )}
      </div>

      <h3 className="hist-heading">Net worth over time</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={netWorthSeries}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A3446" />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#8B99B0" }} />
            <YAxis tick={{ fontSize: 12, fill: "#8B99B0" }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1B2231", border: "1px solid #2A3446", borderRadius: 6, color: "#DDE3EE", fontSize: 12 }} labelStyle={{ color: "#F0F4FA" }} />
            <Line type="monotone" dataKey="netWorth" name="Net worth" stroke="#6BCEB6" strokeWidth={2.5} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ---------------- Wishlist: decision engine ---------------- */

function currentFinancials(sortedMonths) {
  if (sortedMonths.length === 0) {
    return { balance: 0, avgSavings: 0, monthlyExpenses: 0, debtInterest: 0, debtTotal: 0,
             hasInterestBearingDebt: false, unusedCardLimit: 0, oldLent: [], cardsInGoodStanding: true };
  }
  const last = sortedMonths[sortedMonths.length - 1];
  const c = computeMonth(last, sortedMonths);
  const last3 = sortedMonths.slice(-3);
  const avgSavings = last3.length
    ? last3.reduce((s, m) => s + computeMonth(m, sortedMonths).savingsActual, 0) / last3.length
    : 0;
  const monthlyExpenses = last3.length
    ? last3.reduce((s, m) => s + computeMonth(m, sortedMonths).expActual, 0) / last3.length
    : c.expActual;
  const debtInterest = (last.debts || [])
    .filter(d => d.type === "interest-bearing")
    .reduce((s, d) => s + (effectiveOutstanding(d, last.key, sortedMonths) * num(d.interestRate) / 100 / 12), 0);
  const hasInterestBearingDebt = (last.debts || []).some(d => d.type === "interest-bearing" && effectiveOutstanding(d, last.key, sortedMonths) > 0);
  const oldLent = (last.lent || []).filter(r => num(r.amount) > 0 && daysSince(r.date) >= 90);
  // Cards are in "good standing" if the last 3 months' bills were fully paid
  const cardsInGoodStanding = last3.every(m =>
    (m.cc || []).every(card => !num(card.due) || num(card.paid) >= num(card.due))
  );
  return {
    balance: c.closingBalance,
    avgSavings,
    monthlyExpenses,
    debtInterest,
    debtTotal: c.debtTotal,
    hasInterestBearingDebt,
    unusedCardLimit: 0, // user doesn't currently track credit limits — future enhancement
    oldLent,
    cardsInGoodStanding
  };
}

function runwayMonths(balance, monthlyExpenses) {
  if (monthlyExpenses <= 0) return balance > 0 ? Infinity : 0;
  return balance / monthlyExpenses;
}

// Standard 40/20/15/15/10 rubric for non-Critical items.
// For High-priority items, priority weight jumps to 25% (borrowed from affordability -> 30%).
function scoreItem(item, fin, goals) {
  const cost = num(item.cost);
  if (cost <= 0) return { score: 0, reasons: [] };

  const isHigh = item.priority === "High";
  const wAff = isHigh ? 30 : 40;
  const wGoals = 20;
  const wDebt = 15;
  const wPriority = isHigh ? 25 : 15;
  const wCostRel = 10;

  const reasons = [];

  // Affordability (0-1)
  const balanceAfter = fin.balance - cost;
  const runwayAfter = runwayMonths(balanceAfter, fin.monthlyExpenses);
  let aff;
  if (balanceAfter >= 0 && runwayAfter >= 3) { aff = 1.0; reasons.push({ tone: "good", text: `You can pay from savings and keep ${runwayAfter.toFixed(1)} months of runway.` }); }
  else if (balanceAfter >= 0 && runwayAfter >= 1) { aff = 0.55; reasons.push({ tone: "warn", text: `Paying from savings drops runway to ${runwayAfter.toFixed(1)} months (below the safe 3-month floor).` }); }
  else if (balanceAfter >= 0) { aff = 0.25; reasons.push({ tone: "warn", text: `Paying from savings leaves less than 1 month of runway.` }); }
  else { aff = 0.0; reasons.push({ tone: "bad", text: `Savings alone can't cover this — you'd need ${fmt(-balanceAfter)} more, likely via debt.` }); }

  // Goal impact (0-1)
  const activeGoals = goals.filter(g => num(g.target) > 0 && num(g.saved) < num(g.target));
  let goalScore = 1.0;
  if (activeGoals.length > 0 && fin.avgSavings > 0) {
    const monthsDelay = cost / fin.avgSavings;
    if (monthsDelay >= 6) { goalScore = 0.1; reasons.push({ tone: "bad", text: `Would delay your goals by about ${monthsDelay.toFixed(0)} months.` }); }
    else if (monthsDelay >= 3) { goalScore = 0.4; reasons.push({ tone: "warn", text: `Would delay your goals by about ${monthsDelay.toFixed(0)} months.` }); }
    else if (monthsDelay >= 1) { goalScore = 0.75; reasons.push({ tone: "warn", text: `Would delay your goals by about ${monthsDelay.toFixed(1)} months.` }); }
  }

  // Debt situation (0-1)
  let debtScore = 1.0;
  if (fin.hasInterestBearingDebt) {
    if (item.purpose === "need") debtScore = 0.7;
    else { debtScore = 0.3; reasons.push({ tone: "bad", text: `You have interest-bearing debt costing ~${fmt(fin.debtInterest)}/mo — clear that first.` }); }
  }

  // Priority × purpose (0-1)
  const priorityMap = { Low: 0.2, Medium: 0.5, High: 0.85, Critical: 1.0 };
  const purposeMap = { need: 1.0, investment: 0.9, want: 0.5 };
  const priorityScore = (priorityMap[item.priority] ?? 0.5) * (purposeMap[item.purpose] ?? 0.5);

  // Cost-relative-to-savings (0-1)
  let costRelScore = 1.0;
  if (fin.avgSavings > 0) {
    const monthsOfSavings = cost / fin.avgSavings;
    if (monthsOfSavings >= 6) { costRelScore = 0.2; reasons.push({ tone: "warn", text: `Costs ${monthsOfSavings.toFixed(0)} months of your average savings — plan deliberately.` }); }
    else if (monthsOfSavings >= 3) costRelScore = 0.5;
    else if (monthsOfSavings >= 1) costRelScore = 0.8;
  }

  const raw =
    aff * wAff +
    goalScore * wGoals +
    debtScore * wDebt +
    priorityScore * wPriority +
    costRelScore * wCostRel;

  return { score: Math.round(raw), reasons };
}

function verdict(score) {
  if (score >= 75) return { level: "go", label: "Go ahead", color: "green" };
  if (score >= 50) return { level: "wait", label: "Wait a bit", color: "amber" };
  if (score >= 25) return { level: "reconsider", label: "Reconsider", color: "orange" };
  return { level: "no", label: "Don't buy", color: "red" };
}

// Funding scenarios for Critical items (and for anyone who wants to explore).
function buildFundingScenarios(item, fin, goals) {
  const cost = num(item.cost);
  const scenarios = [];

  // 1. Pay from savings, keeping 3-month floor
  const floor = 3 * fin.monthlyExpenses;
  const balanceAfter = fin.balance - cost;
  if (balanceAfter >= floor) {
    scenarios.push({
      id: "savings-safe",
      title: "Pay from savings (safe)",
      tone: "good",
      steps: [`Withdraw ${fmt(cost)} from Savings Balance`],
      after: { balance: balanceAfter, runway: runwayMonths(balanceAfter, fin.monthlyExpenses), interest: 0, monthsToRecover: fin.avgSavings > 0 ? Math.ceil(cost / fin.avgSavings) : null },
      apply: (month, goals) => {
        const existing = month.wishlistWithdrawals || [];
        if (existing.some(w => w.wishlistItemId === item.id)) {
          return { month, goals, alreadyApplied: true };
        }
        return {
          month: {
            ...month,
            wishlistWithdrawals: [...existing, { wishlistItemId: item.id, amount: Math.round(cost), addedOn: month.key }]
          },
          goals
        };
      },
      confirm: `Add a ${fmt(cost)} withdrawal to this month's Savings Balance. Tagged to this wishlist item so it can be reversed if you unfund the item.`
    });
  } else if (balanceAfter >= 0) {
    scenarios.push({
      id: "savings-tight",
      title: "Pay from savings (leaves low runway)",
      tone: "warn",
      steps: [`Withdraw ${fmt(cost)} from Savings Balance`, `Warning: leaves ${runwayMonths(balanceAfter, fin.monthlyExpenses).toFixed(1)} months of runway`],
      after: { balance: balanceAfter, runway: runwayMonths(balanceAfter, fin.monthlyExpenses), interest: 0, monthsToRecover: fin.avgSavings > 0 ? Math.ceil(cost / fin.avgSavings) : null },
      apply: (month, goals) => {
        const existing = month.wishlistWithdrawals || [];
        if (existing.some(w => w.wishlistItemId === item.id)) {
          return { month, goals, alreadyApplied: true };
        }
        return {
          month: {
            ...month,
            wishlistWithdrawals: [...existing, { wishlistItemId: item.id, amount: Math.round(cost), addedOn: month.key }]
          },
          goals
        };
      },
      confirm: `Add a ${fmt(cost)} withdrawal. This will leave you with ${runwayMonths(balanceAfter, fin.monthlyExpenses).toFixed(1)} months of expense runway — below the safe 3-month floor.`
    });
  }

  // 3. Savings + pause a goal (only if goals exist and savings alone is tight)
  const activeGoals = goals.map((g, i) => ({ ...g, idx: i })).filter(g => num(g.target) > 0 && num(g.saved) < num(g.target));
  if (activeGoals.length > 0 && (balanceAfter < floor || balanceAfter < 0)) {
    const goalToTouch = activeGoals.reduce((min, g) => (num(g.saved) / num(g.target)) < (num(min.saved) / num(min.target)) ? g : min);
    const freeUp = Math.min(num(goalToTouch.saved), Math.max(0, cost - Math.max(0, fin.balance - floor)));
    if (freeUp > 0) {
      const partFromSavings = cost - freeUp;
      scenarios.push({
        id: "savings-plus-goal",
        title: `Savings + reduce "${goalToTouch.name || "goal"}" contribution`,
        tone: "warn",
        steps: [
          `Withdraw ${fmt(partFromSavings)} from Savings Balance`,
          `Reduce your "${goalToTouch.name || "goal"}" saved amount by ${fmt(freeUp)}`
        ],
        after: { balance: fin.balance - partFromSavings, runway: runwayMonths(fin.balance - partFromSavings, fin.monthlyExpenses), interest: 0, monthsToRecover: fin.avgSavings > 0 ? Math.ceil(cost / fin.avgSavings) : null },
        apply: (month, goals) => {
          const existing = month.wishlistWithdrawals || [];
          if (existing.some(w => w.wishlistItemId === item.id)) {
            return { month, goals, alreadyApplied: true };
          }
          return {
            month: {
              ...month,
              wishlistWithdrawals: [...existing, { wishlistItemId: item.id, amount: Math.round(partFromSavings), goalIdxDelta: { idx: goalToTouch.idx, amount: Math.round(freeUp) }, addedOn: month.key }]
            },
            goals: goals.map((g, i) => i === goalToTouch.idx ? { ...g, saved: num(g.saved) - freeUp } : g)
          };
        },
        confirm: `Withdraw ${fmt(partFromSavings)} from savings and reduce your "${goalToTouch.name || "goal"}" saved amount by ${fmt(freeUp)}. Goal completion will be delayed accordingly.`
      });
    }
  }

  // 4. Recall from lent-out (only if there are old outstanding entries)
  if (fin.oldLent.length > 0) {
    const totalOld = fin.oldLent.reduce((s, r) => s + num(r.amount), 0);
    scenarios.push({
      id: "recall-lent",
      title: "Recall outstanding money you've lent",
      tone: "good",
      steps: [
        `Follow up with: ${fin.oldLent.map(r => `${r.name || "?"} (${fmt(num(r.amount))})`).join(", ")}`,
        totalOld >= cost ? `Recovering these would fully cover the purchase.` : `Would cover ${((totalOld / cost) * 100).toFixed(0)}% of the cost; combine with savings for the rest.`
      ],
      after: { balance: fin.balance + totalOld - cost, runway: runwayMonths(fin.balance + totalOld - cost, fin.monthlyExpenses), interest: 0, monthsToRecover: fin.avgSavings > 0 ? Math.ceil(Math.max(0, cost - totalOld) / fin.avgSavings) : null },
      apply: (month, goals) => ({
        // Doesn't auto-clear lent entries — just adds a home-tab reminder note
        month: { ...month, wishlistReminders: [...(month.wishlistReminders || []), `Follow up on lent-out amounts to fund: ${item.name}`] },
        goals
      }),
      confirm: `A reminder will be added to Home to follow up on these lent-out amounts. No amounts will be auto-cleared — mark them collected on the Lent Out tab when the money comes back.`
    });
  }

  // 5. Credit card, pay in full next cycle (only if cards are in good standing and cost <= next month's expected savings)
  if (fin.cardsInGoodStanding && fin.avgSavings >= cost) {
    scenarios.push({
      id: "cc-full",
      title: "Card, pay in full next statement",
      tone: "good",
      steps: [
        `Put the ${fmt(cost)} on a card`,
        `Pay in full on the next statement (about 30 days)`,
        `No interest — buys you a month of float`
      ],
      after: { balance: fin.balance, runway: runwayMonths(fin.balance, fin.monthlyExpenses), interest: 0, monthsToRecover: 1 },
      apply: (month, goals) => ({ month, goals }),
      confirm: `No automation applied — just a plan. Put the amount on your card; when the bill arrives, pay it in full via the Credit Cards section.`,
      manual: true
    });
  }

  // 6. Card EMI conversion (assume 13% annual, 6-month term as a reasonable default)
  {
    const annualRate = 0.13;
    const months = 6;
    const monthlyRate = annualRate / 12;
    const emi = (cost * monthlyRate * Math.pow(1 + monthlyRate, months)) / (Math.pow(1 + monthlyRate, months) - 1);
    const totalPaid = emi * months;
    const totalInterest = totalPaid - cost;
    scenarios.push({
      id: "cc-emi",
      title: `Card EMI (${months}-month, ~${(annualRate * 100).toFixed(0)}% annual)`,
      tone: "warn",
      steps: [
        `Convert the ${fmt(cost)} purchase to a ${months}-month EMI at ~${(annualRate * 100).toFixed(0)}% annual`,
        `Monthly EMI: ${fmt(emi)} for ${months} months`,
        `Total interest cost: ${fmt(totalInterest)}`,
        `Debt balance auto-decrements each month; entry drops off once fully paid.`
      ],
      after: { balance: fin.balance, runway: runwayMonths(fin.balance, fin.monthlyExpenses), interest: totalInterest, monthsToRecover: months, emi: emi, emiMonths: months },
      apply: (month, goals) => {
        // Idempotency: refuse to add if this wishlist item already produced EMI rows in this month.
        if ((month.fixed || []).some(f => f.wishlistItemId === item.id) ||
            (month.debts || []).some(d => d.wishlistItemId === item.id)) {
          return { month, goals, alreadyApplied: true };
        }
        const plan = {
          startKey: month.key,
          totalMonths: months,
          principal: Math.round(cost),
          annualRate: annualRate * 100,
          monthlyEmi: Math.round(emi)
        };
        return {
          month: {
            ...month,
            fixed: [...(month.fixed || []), { name: `${item.name} EMI`, budget: Math.round(emi), actual: null, emiPlan: plan, wishlistItemId: item.id }],
            debts: [...(month.debts || []), { name: `${item.name} EMI (${months}mo)`, outstanding: Math.round(cost), type: "interest-bearing", interestRate: annualRate * 100, emiPlan: plan, wishlistItemId: item.id }]
          },
          goals
        };
      },
      confirm: `Add "${item.name} EMI" as a Fixed Expense (₹${Math.round(emi).toLocaleString("en-IN")}/mo) and add ${fmt(cost)} as an interest-bearing Debt at ${(annualRate * 100).toFixed(0)}% annual. Both entries auto-drop off after ${months} months.`
    });
  }

  // 7. Personal loan (only shown if none of the above work well)
  if (balanceAfter < 0) {
    const annualRate = 0.14;
    const months = 12;
    const monthlyRate = annualRate / 12;
    const emi = (cost * monthlyRate * Math.pow(1 + monthlyRate, months)) / (Math.pow(1 + monthlyRate, months) - 1);
    const totalInterest = emi * months - cost;
    scenarios.push({
      id: "personal-loan",
      title: `Personal loan (${months}-month, ~${(annualRate * 100).toFixed(0)}% annual)`,
      tone: "bad",
      steps: [
        `Take a personal loan for ${fmt(cost)}`,
        `Monthly EMI: ${fmt(emi)} for ${months} months`,
        `Total interest cost: ${fmt(totalInterest)}`,
        `Debt balance auto-decrements each month; entry drops off once fully paid.`
      ],
      after: { balance: fin.balance, runway: runwayMonths(fin.balance, fin.monthlyExpenses), interest: totalInterest, monthsToRecover: months, emi: emi, emiMonths: months },
      apply: (month, goals) => {
        if ((month.fixed || []).some(f => f.wishlistItemId === item.id) ||
            (month.debts || []).some(d => d.wishlistItemId === item.id)) {
          return { month, goals, alreadyApplied: true };
        }
        const plan = {
          startKey: month.key,
          totalMonths: months,
          principal: Math.round(cost),
          annualRate: annualRate * 100,
          monthlyEmi: Math.round(emi)
        };
        return {
          month: {
            ...month,
            fixed: [...(month.fixed || []), { name: `${item.name} loan EMI`, budget: Math.round(emi), actual: null, emiPlan: plan, wishlistItemId: item.id }],
            debts: [...(month.debts || []), { name: `${item.name} personal loan`, outstanding: Math.round(cost), type: "interest-bearing", interestRate: annualRate * 100, emiPlan: plan, wishlistItemId: item.id }]
          },
          goals
        };
      },
      confirm: `Add "${item.name} loan EMI" as a Fixed Expense and add ${fmt(cost)} as an interest-bearing Debt at ${(annualRate * 100).toFixed(0)}% annual. Both auto-drop off after ${months} months. Only proceed if you actually secure the loan.`
    });
  }

  // Rank: lowest interest, best runway, fewest steps
  scenarios.sort((a, b) => {
    if (a.after.interest !== b.after.interest) return a.after.interest - b.after.interest;
    return b.after.runway - a.after.runway;
  });

  return scenarios;
}

/* ---------------- Wishlist tab ---------------- */

function WishlistTab({ wishlist, setWishlist, month, setMonth, goals, setGoals, allMonths, saveNow }) {
  rowCounter = 0;
  const sortedMonths = [...allMonths].sort((a, b) => a.key.localeCompare(b.key));
  const fin = currentFinancials(sortedMonths);
  const [expanded, setExpanded] = useState(null); // item id
  const [confirmPlan, setConfirmPlan] = useState(null); // {item, scenario}

  const update = (id, field, value) => setWishlist(prev => prev.map(x => x.id === id ? { ...x, [field]: value } : x));
  const addItem = () => setWishlist(prev => [...prev, {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: "", cost: null, category: "personal", priority: "Medium", purpose: "want",
    timeSensitivity: "whenever", replaces: false, emotionalPull: 3, notes: "",
    criticalReason: "", check1: false, check2: false, check3: false,
    addedOn: new Date().toISOString().slice(0, 10), status: "pending"
  }]);
  const removeItem = id => setWishlist(prev => prev.filter(x => x.id !== id));

  const criticalCount = wishlist.filter(x => x.priority === "Critical" && x.status === "pending").length;

  const applyPlan = async () => {
    if (!confirmPlan) return;
    const { item, scenario } = confirmPlan;
    const result = scenario.apply(month, goals);
    if (result.alreadyApplied) {
      // Idempotent guard: this plan was already applied to this month.
      alert(`This plan has already been applied to ${monthLabel(month.key)}. Use "Unfund" to reverse it first.`);
      setConfirmPlan(null);
      return;
    }
    setMonth(() => result.month);
    setGoals(() => result.goals);
    setWishlist(prev => prev.map(x => x.id === item.id ? { ...x, status: "funded", fundingScenario: scenario.id, fundedOn: new Date().toISOString().slice(0, 10), fundedInMonth: month.key } : x));
    setConfirmPlan(null);
    setExpanded(null);
    // saveNow uses refs, so it always reads the freshest state.
    if (saveNow) await saveNow();
  };

  // Unfund a previously funded item: reverse whatever the plan added.
  const unfundItem = async (item) => {
    if (!item.fundedInMonth) {
      alert("Can't identify which month this was funded in. Please unfund manually.");
      return;
    }
    if (!confirm(`Unfund "${item.name || 'this item'}"? This will remove the associated EMI, debt, or withdrawal entries.`)) return;
    // Find the month it was funded in
    const targetKey = item.fundedInMonth;
    // If it's the current month, we can update in-place; otherwise we need to load & rewrite that month.
    // Simplest: only support unfunding items funded in the CURRENT month for now.
    if (targetKey !== month.key) {
      alert(`This item was funded in ${monthLabel(targetKey)}. Please switch to that month first to unfund.`);
      return;
    }
    setMonth(prev => ({
      ...prev,
      fixed: (prev.fixed || []).filter(f => f.wishlistItemId !== item.id),
      debts: (prev.debts || []).filter(d => d.wishlistItemId !== item.id),
      wishlistWithdrawals: (prev.wishlistWithdrawals || []).filter(w => w.wishlistItemId !== item.id)
    }));
    // Restore any goal contribution reduction
    const wd = (month.wishlistWithdrawals || []).find(w => w.wishlistItemId === item.id && w.goalIdxDelta);
    if (wd) {
      setGoals(prev => prev.map((g, i) => i === wd.goalIdxDelta.idx ? { ...g, saved: num(g.saved) + wd.goalIdxDelta.amount } : g));
    }
    setWishlist(prev => prev.map(x => x.id === item.id ? { ...x, status: "pending", fundingScenario: null, fundedOn: null, fundedInMonth: null } : x));
    if (saveNow) await saveNow();
  };

  return (
    <div>
      <div className="goal-note">
        Available for decisions: Savings balance {fmt(fin.balance)} · Avg monthly savings {fmt(fin.avgSavings)} · Runway {runwayMonths(fin.balance, fin.monthlyExpenses).toFixed(1)} months
        {criticalCount > 0 && <div style={{ marginTop: 4, color: "var(--neg)" }}>⚠ {criticalCount} item{criticalCount > 1 ? "s" : ""} marked Critical this session.</div>}
      </div>

      <SheetWrap cols={7}>
        <SectionTitle title="THINGS I'M CONSIDERING BUYING" span={7} />
        <HeaderRow labels={["Item", "Category", "Cost (₹)", "Priority", "Purpose", "Verdict", ""]} />
        {wishlist.length === 0 && (
          <tr>
            <RowNum />
            <Cell colSpan={6}><span className="muted">Nothing on your wishlist. Click + to add something you're thinking about buying.</span></Cell>
            <Cell align="center"><button className="rowbtn addbtn" onClick={addItem}>+</button></Cell>
          </tr>
        )}
        {wishlist.map((item) => {
          const cost = num(item.cost);
          const isCritical = item.priority === "Critical";
          const criticalChecksPassed = isCritical && item.check1 && item.check2 && item.check3 && (item.criticalReason || "").trim().length > 3;
          const { score, reasons } = scoreItem(item, fin, goals);
          const v = verdict(score);
          const isExpanded = expanded === item.id;
          const isFunded = item.status === "funded";

          return (
            <Fragment key={item.id}>
              <tr>
                <RowNum />
                <Cell><EditText value={item.name} onChange={v => update(item.id, "name", v)} placeholder="What are you thinking about?" /></Cell>
                <Cell>
                  <select className="editin" value={item.category} onChange={e => update(item.id, "category", e.target.value)}>
                    <option value="personal">Personal want</option>
                    <option value="family">Family</option>
                    <option value="health">Health</option>
                    <option value="work">Work</option>
                    <option value="home">Home</option>
                    <option value="other">Other</option>
                  </select>
                </Cell>
                <Cell align="right"><EditNum value={item.cost} onChange={v => update(item.id, "cost", v)} /></Cell>
                <Cell>
                  <select className="editin" value={item.priority} onChange={e => update(item.id, "priority", e.target.value)}>
                    <option>Low</option>
                    <option>Medium</option>
                    <option>High</option>
                    <option>Critical</option>
                  </select>
                </Cell>
                <Cell>
                  <select className="editin" value={item.purpose} onChange={e => update(item.id, "purpose", e.target.value)}>
                    <option value="need">Need</option>
                    <option value="want">Want</option>
                    <option value="investment">Investment</option>
                  </select>
                </Cell>
                <Cell>
                  {isFunded ? (
                    <span className="badge badge-green">Funded</span>
                  ) : isCritical ? (
                    <span className="badge badge-red">Critical — plan it</span>
                  ) : cost > 0 ? (
                    <span className={"badge " + (v.color === "green" ? "badge-green" : v.color === "amber" ? "badge-amber" : v.color === "orange" ? "badge-amber" : "badge-red")}>
                      {v.label} · {score}
                    </span>
                  ) : (
                    <span className="muted">Enter cost</span>
                  )}
                </Cell>
                <Cell align="center">
                  <button className="rowbtn addbtn" style={{ marginRight: 4 }} onClick={() => setExpanded(isExpanded ? null : item.id)}>{isExpanded ? "−" : "▸"}</button>
                  {isFunded && (
                    <button className="rowbtn" style={{ marginRight: 4, color: "var(--warn)", borderColor: "var(--warn)", width: "auto", padding: "0 6px", fontSize: 11 }} onClick={() => unfundItem(item)} title="Reverse this funding plan">Unfund</button>
                  )}
                  <button className="rowbtn" onClick={() => removeItem(item.id)}>×</button>
                </Cell>
              </tr>

              {isExpanded && (
                <tr>
                  <td className="rownum" />
                  <td colSpan={7} className="wishlist-detail">
                    {isCritical && (
                      <div className="wishlist-critical">
                        <div className="wishlist-detail-title">Critical check</div>
                        <p className="wishlist-detail-hint">Critical items skip affordability rules and go straight to funding. Please answer honestly.</p>
                        <div style={{ marginBottom: 8 }}>
                          <div className="wishlist-detail-label">Why is this critical?</div>
                          <EditText value={item.criticalReason} onChange={v => update(item.id, "criticalReason", v)} placeholder="e.g. Dad's hearing aid broke; laptop died mid-project" />
                        </div>
                        <label className="wishlist-check"><input type="checkbox" checked={item.check1} onChange={e => update(item.id, "check1", e.target.checked)} /> Not buying this causes real harm (health / safety / income / family)</label>
                        <label className="wishlist-check"><input type="checkbox" checked={item.check2} onChange={e => update(item.id, "check2", e.target.checked)} /> Waiting 30 days would make things meaningfully worse</label>
                        <label className="wishlist-check"><input type="checkbox" checked={item.check3} onChange={e => update(item.id, "check3", e.target.checked)} /> No cheaper substitute exists</label>
                        {!criticalChecksPassed && (
                          <div style={{ marginTop: 6, fontSize: 12, color: "var(--warn)" }}>
                            Fill in a reason and confirm all three checks to see funding options. If any answer is "no", consider changing priority to <b>High</b> instead.
                          </div>
                        )}
                      </div>
                    )}

                    {!isCritical && cost > 0 && (
                      <>
                        <div className="wishlist-detail-title">Why this verdict?</div>
                        <ul className="wishlist-reasons">
                          {reasons.length === 0 ? <li className="reason-good">Looks straightforward — no red flags.</li> : reasons.map((r, i) => (
                            <li key={i} className={"reason-" + r.tone}>{r.text}</li>
                          ))}
                        </ul>
                      </>
                    )}

                    {cost > 0 && (isCritical ? criticalChecksPassed : true) && !isFunded && (
                      <>
                        <div className="wishlist-detail-title" style={{ marginTop: 12 }}>Funding options</div>
                        <p className="wishlist-detail-hint">
                          {isCritical
                            ? "Pick a plan you're comfortable with. Confirmation is required before anything changes."
                            : "Even if the verdict is Wait or Reconsider, you can see how you'd fund this."}
                        </p>
                        <div className="funding-list">
                          {buildFundingScenarios(item, fin, goals).map((sc, i) => (
                            <div key={sc.id} className={"funding-scenario funding-" + sc.tone + (i === 0 ? " funding-recommended" : "")}>
                              <div className="funding-head">
                                <span className="funding-title">{sc.title}</span>
                                {i === 0 && <span className="funding-recommended-badge">Recommended</span>}
                              </div>
                              <ul className="funding-steps">
                                {sc.steps.map((s, j) => <li key={j}>{s}</li>)}
                              </ul>
                              <div className="funding-after">
                                <span>Balance after: <b>{fmt(sc.after.balance)}</b></span>
                                <span>Runway after: <b>{isFinite(sc.after.runway) ? sc.after.runway.toFixed(1) + "mo" : "∞"}</b></span>
                                <span>Interest cost: <b>{fmt(sc.after.interest)}</b></span>
                                {sc.after.monthsToRecover !== null && <span>Time to recover: <b>{sc.after.monthsToRecover}mo</b></span>}
                              </div>
                              <button className="funding-apply" onClick={() => setConfirmPlan({ item, scenario: sc })}>
                                {sc.manual ? "Log this plan" : "Apply this plan"}
                              </button>
                            </div>
                          ))}
                        </div>
                      </>
                    )}

                    <div style={{ marginTop: 12 }}>
                      <div className="wishlist-detail-label">Notes</div>
                      <EditText value={item.notes} onChange={v => update(item.id, "notes", v)} placeholder="Any other details" />
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
        {wishlist.length > 0 && (
          <tr className="total-row">
            <RowNum />
            <Cell strong>{wishlist.length} item{wishlist.length > 1 ? "s" : ""}</Cell>
            <Cell />
            <Cell align="right" strong>{fmt(wishlist.reduce((s, x) => s + num(x.cost), 0))}</Cell>
            <Cell /><Cell /><Cell />
            <Cell align="center"><button className="rowbtn addbtn" onClick={addItem}>+</button></Cell>
          </tr>
        )}
      </SheetWrap>

      {confirmPlan && (
        <div className="modal-backdrop" onClick={() => setConfirmPlan(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Confirm this plan</h3>
            <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-mid)" }}>{confirmPlan.scenario.confirm}</p>
            <div className="modal-actions">
              <button className="signoutbtn" onClick={() => setConfirmPlan(null)}>Cancel</button>
              <button className="savebtn" onClick={applyPlan}>Confirm & apply</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- History tab ---------------- */

function HistoryTab({ allMonths }) {
  const sorted = [...allMonths].sort((a, b) => a.key.localeCompare(b.key));

  const rows = sorted.map(m => {
    const c = computeMonth(m, allMonths);
    return {
      key: m.key,
      shortLabel: monthLabel(m.key),
      income: num(m.income.actual) > 0 ? num(m.income.actual) : num(m.income.expected),
      expenses: c.expActual,
      nonCard: c.nonCardActual,
      cardSpend: c.ccPaid,
      savings: c.savingsActual,
      rate: c.rateActual,
      accuracy: c.budgetAccuracy,
      balance: c.closingBalance,
      withdrawals: c.withdrawals,
      portfolio: c.currentValueTotal,
      netWorth: c.netWorth,
      lentTotal: c.lentTotal,
      cc: Object.fromEntries(m.cc.map(r => [r.name, num(r.paid)]))
    };
  });

  const cardNames = Array.from(new Set(sorted.flatMap(m => m.cc.map(r => r.name))));
  const ccData = rows.map(r => ({ month: r.shortLabel, total: r.cardSpend, ...r.cc }));
  const ccColors = ["#6BCEB6", "#8FB8E5", "#E88B7A", "#E8C46B", "#B79EDD", "#7FD1B8"];

  const catNames = Array.from(new Set(
    sorted.flatMap(m => [...m.fixed, ...m.variable].map(r => (r.name || "").trim())).filter(Boolean)
  ));
  const [selectedCat, setSelectedCat] = useState(catNames[0] || "");
  const activeCat = catNames.includes(selectedCat) ? selectedCat : (catNames[0] || "");
  const catData = sorted.map(m => {
    const row = m.fixed.find(r => (r.name || "").trim() === activeCat) ||
                m.variable.find(r => (r.name || "").trim() === activeCat);
    return { month: monthLabel(m.key), budget: row ? num(row.budget) : 0, actual: row ? num(row.actual) : 0 };
  });

  const last = rows[rows.length - 1];
  const prevTwo = rows.slice(-3, -1);
  const prevAvg = prevTwo.length ? prevTwo.reduce((s, r) => s + r.savings, 0) / prevTwo.length : null;
  const diff = last && prevAvg !== null ? last.savings - prevAvg : null;

  const accRows = rows.filter(r => r.accuracy !== null);
  const avgAccuracy = accRows.length ? accRows.reduce((s, r) => s + r.accuracy, 0) / accRows.length : null;

  const hasInvestments = rows.some(r => r.portfolio > 0);

  if (rows.length < 1) {
    return <div className="empty-state">No months saved yet. Fill in the sheet and it will appear here.</div>;
  }

  return (
    <div className="history">
      {last && (
        <div className="stat-cards">
          <div className="stat-card">
            <div className="stat-label">This month's savings</div>
            <div className="stat-value">{fmt(last.savings)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Change vs. prior 2 months</div>
            <div className={"stat-value " + (diff !== null && diff >= 0 ? "pos" : diff !== null ? "neg" : "")}>
              {diff !== null ? (diff >= 0 ? "+" : "") + fmt(diff) : "-"}
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Savings balance (actual)</div>
            <div className={"stat-value " + (last.balance >= 0 ? "pos" : "neg")}>{fmt(last.balance)}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Budget accuracy (avg)</div>
            <div className="stat-value">{avgAccuracy !== null ? avgAccuracy.toFixed(1) + "%" : "-"}</div>
          </div>
        </div>
      )}

      <h3 className="hist-heading">Income, expenses & savings over time</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A3446" />
            <XAxis dataKey="shortLabel" tick={{ fontSize: 12, fill: "#8B99B0" }} />
            <YAxis tick={{ fontSize: 12, fill: "#8B99B0" }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1B2231", border: "1px solid #2A3446", borderRadius: 6, color: "#DDE3EE", fontSize: 12 }} labelStyle={{ color: "#F0F4FA" }} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#DDE3EE" }} />
            <Line type="monotone" dataKey="income" name="Income" stroke="#8FB8E5" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="expenses" name="Total expenses" stroke="#E88B7A" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="savings" name="Savings" stroke="#6BCEB6" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3 className="hist-heading">Expense composition over time</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A3446" />
            <XAxis dataKey="shortLabel" tick={{ fontSize: 12, fill: "#8B99B0" }} />
            <YAxis tick={{ fontSize: 12, fill: "#8B99B0" }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1B2231", border: "1px solid #2A3446", borderRadius: 6, color: "#DDE3EE", fontSize: 12 }} labelStyle={{ color: "#F0F4FA" }} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#DDE3EE" }} />
            <Line type="monotone" dataKey="expenses" name="Total expense" stroke="#F0F4FA" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="nonCard" name="Non-card expense" stroke="#8FB8E5" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="cardSpend" name="Card spend" stroke="#E88B7A" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3 className="hist-heading">Credit card spend by card</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={ccData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A3446" />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#8B99B0" }} />
            <YAxis tick={{ fontSize: 12, fill: "#8B99B0" }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1B2231", border: "1px solid #2A3446", borderRadius: 6, color: "#DDE3EE", fontSize: 12 }} labelStyle={{ color: "#F0F4FA" }} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#DDE3EE" }} />
            {cardNames.map((name, i) => (
              <Bar key={name} dataKey={name} fill={ccColors[i % ccColors.length]} />
            ))}
            <Line type="monotone" dataKey="total" name="Total card spend" stroke="#F0F4FA" strokeWidth={2} dot={{ r: 3 }} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="hist-heading-row">
        <h3 className="hist-heading">Category trend</h3>
        <select className="monthselect" value={activeCat} onChange={e => setSelectedCat(e.target.value)}>
          {catNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={catData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A3446" />
            <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#8B99B0" }} />
            <YAxis tick={{ fontSize: 12, fill: "#8B99B0" }} tickFormatter={v => `₹${(v / 1000).toFixed(1)}k`} />
            <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1B2231", border: "1px solid #2A3446", borderRadius: 6, color: "#DDE3EE", fontSize: 12 }} labelStyle={{ color: "#F0F4FA" }} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#DDE3EE" }} />
            <Line type="monotone" dataKey="budget" name="Budget" stroke="#E8C46B" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="actual" name="Actual" stroke="#6BCEB6" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3 className="hist-heading">Savings balance over time</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A3446" />
            <XAxis dataKey="shortLabel" tick={{ fontSize: 12, fill: "#8B99B0" }} />
            <YAxis tick={{ fontSize: 12, fill: "#8B99B0" }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1B2231", border: "1px solid #2A3446", borderRadius: 6, color: "#DDE3EE", fontSize: 12 }} labelStyle={{ color: "#F0F4FA" }} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#DDE3EE" }} />
            <Line type="monotone" dataKey="balance" name="Closing balance" stroke="#6BCEB6" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="withdrawals" name="Withdrawn that month" stroke="#E88B7A" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3 className="hist-heading">Net worth over time</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A3446" />
            <XAxis dataKey="shortLabel" tick={{ fontSize: 12, fill: "#8B99B0" }} />
            <YAxis tick={{ fontSize: 12, fill: "#8B99B0" }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1B2231", border: "1px solid #2A3446", borderRadius: 6, color: "#DDE3EE", fontSize: 12 }} labelStyle={{ color: "#F0F4FA" }} />
            <Legend wrapperStyle={{ fontSize: 11, color: "#DDE3EE" }} />
            <Line type="monotone" dataKey="netWorth" name="Net worth" stroke="#6BCEB6" strokeWidth={2.5} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="balance" name="Savings balance" stroke="#8FB8E5" strokeWidth={1.5} dot={{ r: 2 }} strokeDasharray="3 3" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {hasInvestments && (
        <>
          <h3 className="hist-heading">Portfolio value over time</h3>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A3446" />
                <XAxis dataKey="shortLabel" tick={{ fontSize: 12, fill: "#8B99B0" }} />
                <YAxis tick={{ fontSize: 12, fill: "#8B99B0" }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#1B2231", border: "1px solid #2A3446", borderRadius: 6, color: "#DDE3EE", fontSize: 12 }} labelStyle={{ color: "#F0F4FA" }} />
                <Legend wrapperStyle={{ fontSize: 11, color: "#DDE3EE" }} />
                <Line type="monotone" dataKey="portfolio" name="Portfolio value" stroke="#6b46c1" strokeWidth={2} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      <h3 className="hist-heading">Monthly summary</h3>
      <div className="sheet-scroll">
        <table className="sheet hist-table">
          <thead>
            <tr className="colhead-row">
              <td className="colhead">Month</td>
              <td className="colhead">Income</td>
              <td className="colhead">Expenses</td>
              <td className="colhead">Savings</td>
              <td className="colhead">Savings rate</td>
              <td className="colhead">Budget accuracy</td>
              <td className="colhead">Savings balance</td>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <Cell strong>{r.shortLabel}</Cell>
                <Cell align="right">{fmt(r.income)}</Cell>
                <Cell align="right">{fmt(r.expenses)}</Cell>
                <Cell align="right">{fmt(r.savings)}</Cell>
                <Cell align="right">{r.rate.toFixed(1)}%</Cell>
                <Cell align="right">{r.accuracy !== null ? r.accuracy.toFixed(1) + "%" : "-"}</Cell>
                <Cell align="right">{fmt(r.balance)}</Cell>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ---------------- Login ---------------- */

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError("Couldn't sign in. Check your email and password.");
    }
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <style>{`
        .login-wrap { min-height: 60vh; display: flex; align-items: center; justify-content: center; font-family: 'Inter', -apple-system, sans-serif; background: #131822; padding: 20px; }
        .login-form { background: #1B2231; border: 1px solid #1E2632; border-radius: 10px; padding: 32px 28px; width: 300px; }
        .login-form h2 { margin: 0 0 20px; font-size: 16px; color: #F0F4FA; font-weight: 500; letter-spacing: 0.01em; }
        .login-form input { width: 100%; box-sizing: border-box; padding: 10px 12px; margin-bottom: 10px; border: 1px solid #2A3446; border-radius: 6px; font-family: inherit; font-size: 13px; background: #131822; color: #DDE3EE; }
        .login-form input:focus { outline: 1.5px solid #6BCEB6; border-color: #6BCEB6; }
        .login-form button { width: 100%; padding: 10px; background: #6BCEB6; color: #131822; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; font-family: inherit; font-weight: 500; }
        .login-form button:hover { background: #5EB8A2; }
        .login-form button:disabled { opacity: 0.6; }
        .login-error { color: #E88B7A; font-size: 12px; margin-bottom: 10px; }
      `}</style>
      <form className="login-form" onSubmit={handleSubmit}>
        <h2>Budgetify💰</h2>
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required />
        {error && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}

/* ---------------- Main App (signed-in) ---------------- */

const TABS = [
  { id: "home", label: "Home" },
  { id: "expenses", label: "Expenses" },
  { id: "savings", label: "Savings" },
  { id: "debt", label: "Debt" },
  { id: "lent", label: "Lent Out" },
  { id: "investments", label: "Investments" },
  { id: "goals", label: "Goals" },
  { id: "wishlist", label: "Wishlist" },
  { id: "history", label: "History & trends" }
];

function PlannerApp() {
  const [loading, setLoading] = useState(true);
  const [monthsIndex, setMonthsIndex] = useState([]);
  const [currentKey, setCurrentKey] = useState(null);
  const [month, setMonth] = useState(null);
  const [allMonths, setAllMonths] = useState([]);
  const [goals, setGoals] = useState(defaultGoals());
  const [wishlist, setWishlist] = useState([]);
  const [view, setView] = useState("home");
  const [saveState, setSaveState] = useState("idle");
  const [undoStack, setUndoStack] = useState([]);

  const monthSaveTimer = useRef(null);
  const goalsSaveTimer = useRef(null);
  const wishlistSaveTimer = useRef(null);
  const skipFirstMonthSave = useRef(true);
  const skipFirstGoalsSave = useRef(true);
  const skipFirstWishlistSave = useRef(true);

  // Live refs so async callbacks (setTimeout, applyPlan) can always read current state
  // instead of a stale closure snapshot.
  const monthRef = useRef(null);
  const goalsRef = useRef(null);
  const wishlistRef = useRef(null);
  const allMonthsRef = useRef([]);
  // Track what's pending so switchMonth / addNextMonth can force-flush before navigating.
  const pendingMonthSave = useRef(null);
  const pendingGoalsSave = useRef(null);
  const pendingWishlistSave = useRef(null);

  useEffect(() => { monthRef.current = month; }, [month]);
  useEffect(() => { goalsRef.current = goals; }, [goals]);
  useEffect(() => { wishlistRef.current = wishlist; }, [wishlist]);
  useEffect(() => { allMonthsRef.current = allMonths; }, [allMonths]);

  // Forward-cascade: after month N is saved, walk every later month in chronological order
  // and update each opening balance to match the previous month's closing balance.
  // Defined here (before the save effects that reference it) to avoid Temporal Dead Zone errors.
  const cascadeOpeningBalances = useCallback(async (fromKey) => {
    const all = [...(allMonthsRef.current || [])].sort((a, b) => a.key.localeCompare(b.key));
    const fromIdx = all.findIndex(m => m.key === fromKey);
    if (fromIdx === -1 || fromIdx === all.length - 1) return; // no later months to update

    let running = computeMonth(all[fromIdx], all).closingBalance;
    const updated = [];
    for (let i = fromIdx + 1; i < all.length; i++) {
      const m = all[i];
      const currentOpening = num(m.savingsBalance?.opening);
      if (Math.abs(currentOpening - running) < 0.005) {
        // Opening is already correct — compute this month's closing and continue
        running = computeMonth(m, all).closingBalance;
        continue;
      }
      const patched = {
        ...m,
        savingsBalance: { ...(m.savingsBalance || { withdrawals: null }), opening: running }
      };
      updated.push(patched);
      all[i] = patched;
      running = computeMonth(patched, all).closingBalance;
    }
    if (updated.length === 0) return;

    await Promise.all(updated.map(m => saveMonthDoc(m)));
    setAllMonths(prev => {
      const map = new Map(prev.map(m => [m.key, m]));
      updated.forEach(m => map.set(m.key, m));
      return Array.from(map.values());
    });
    const currentKey = monthRef.current?.key;
    const updatedCurrent = updated.find(m => m.key === currentKey);
    if (updatedCurrent && !pendingMonthSave.current) {
      skipFirstMonthSave.current = true;
      setMonth(updatedCurrent);
    }
  }, []);

  useEffect(() => {
    (async () => {
      let months = await loadAllMonths();
      let keys = months.map(m => m.key).sort();
      if (keys.length === 0) {
        const seed = seedMonth();
        await saveMonthDoc(seed);
        months = [seed];
        keys = [seed.key];
      }
      setMonthsIndex(keys);
      setAllMonths(months);
      // Choose the best initial month to show:
      // 1. If today's month exists, show it
      // 2. Otherwise, the latest month that is NOT in the future (relative to today)
      // 3. Otherwise (all months are future), the earliest of them
      const today = todayKey();
      let initialKey;
      if (keys.includes(today)) {
        initialKey = today;
      } else {
        const nonFuture = keys.filter(k => k <= today);
        if (nonFuture.length > 0) {
          initialKey = nonFuture[nonFuture.length - 1];
        } else {
          initialKey = keys[0];
        }
      }
      setCurrentKey(initialKey);
      setMonth(months.find(m => m.key === initialKey));
      const g = await loadGoalsDoc();
      setGoals(g);
      const w = await loadWishlistDoc();
      setWishlist(w);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!month) return;
    if (skipFirstMonthSave.current) { skipFirstMonthSave.current = false; return; }
    setSaveState("saving");
    pendingMonthSave.current = month;
    if (monthSaveTimer.current) clearTimeout(monthSaveTimer.current);
    monthSaveTimer.current = setTimeout(async () => {
      const toSave = pendingMonthSave.current;
      pendingMonthSave.current = null;
      if (toSave) {
        await saveMonthDoc(toSave);
        setAllMonths(prev => {
          const others = prev.filter(m => m.key !== toSave.key);
          return [...others, toSave];
        });
        // Cascade opening balances to later months. Fire-and-forget — it'll trigger UI updates.
        cascadeOpeningBalances(toSave.key).catch(e => console.error("cascade failed", e));
      }
      setSaveState("saved");
    }, 700);
  }, [month, cascadeOpeningBalances]);

  useEffect(() => {
    if (skipFirstGoalsSave.current) { skipFirstGoalsSave.current = false; return; }
    setSaveState("saving");
    pendingGoalsSave.current = goals;
    if (goalsSaveTimer.current) clearTimeout(goalsSaveTimer.current);
    goalsSaveTimer.current = setTimeout(async () => {
      const toSave = pendingGoalsSave.current;
      pendingGoalsSave.current = null;
      if (toSave) await saveGoalsDoc(toSave);
      setSaveState("saved");
    }, 700);
  }, [goals]);

  useEffect(() => {
    if (skipFirstWishlistSave.current) { skipFirstWishlistSave.current = false; return; }
    setSaveState("saving");
    pendingWishlistSave.current = wishlist;
    if (wishlistSaveTimer.current) clearTimeout(wishlistSaveTimer.current);
    wishlistSaveTimer.current = setTimeout(async () => {
      const toSave = pendingWishlistSave.current;
      pendingWishlistSave.current = null;
      if (toSave) await saveWishlistDoc(toSave);
      setSaveState("saved");
    }, 700);
  }, [wishlist]);

  const flushPendingSaves = useCallback(async () => {
    const tasks = [];
    let flushedMonthKey = null;
    if (pendingMonthSave.current) {
      const toSave = pendingMonthSave.current;
      pendingMonthSave.current = null;
      flushedMonthKey = toSave.key;
      if (monthSaveTimer.current) { clearTimeout(monthSaveTimer.current); monthSaveTimer.current = null; }
      tasks.push(saveMonthDoc(toSave).then(() => {
        setAllMonths(prev => {
          const others = prev.filter(m => m.key !== toSave.key);
          return [...others, toSave];
        });
      }));
    }
    if (pendingGoalsSave.current) {
      const toSave = pendingGoalsSave.current;
      pendingGoalsSave.current = null;
      if (goalsSaveTimer.current) { clearTimeout(goalsSaveTimer.current); goalsSaveTimer.current = null; }
      tasks.push(saveGoalsDoc(toSave));
    }
    if (pendingWishlistSave.current) {
      const toSave = pendingWishlistSave.current;
      pendingWishlistSave.current = null;
      if (wishlistSaveTimer.current) { clearTimeout(wishlistSaveTimer.current); wishlistSaveTimer.current = null; }
      tasks.push(saveWishlistDoc(toSave));
    }
    if (tasks.length > 0) {
      setSaveState("saving");
      await Promise.all(tasks);
      if (flushedMonthKey) {
        // Cascade after primary saves are done so allMonthsRef sees the fresh data
        await cascadeOpeningBalances(flushedMonthKey);
      }
      setSaveState("saved");
    }
  }, [cascadeOpeningBalances]);

  // Warn the user if they close the tab with unsaved edits pending.
  useEffect(() => {
    const handler = (e) => {
      if (pendingMonthSave.current || pendingGoalsSave.current || pendingWishlistSave.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const switchMonth = useCallback(async (key) => {
    // Flush pending saves for the CURRENT month before we leave it.
    await flushPendingSaves();
    skipFirstMonthSave.current = true;
    setCurrentKey(key);
    // Read from freshly-updated allMonths (flushPendingSaves has already reconciled).
    // If we can't find it there, fall back to whatever we have in state.
    const target = allMonthsRef.current.find(m => m.key === key);
    setMonth(target || null);
    setUndoStack([]);
  }, [flushPendingSaves]);

  // Wrap setMonth so every user edit pushes the previous state onto the undo stack.
  const setMonthWithUndo = useCallback((updater) => {
    setMonth(prev => {
      if (prev) setUndoStack(s => [...s.slice(-19), { type: "month", key: prev.key, value: prev }]);
      return typeof updater === "function" ? updater(prev) : updater;
    });
  }, []);
  const setGoalsWithUndo = useCallback((updater) => {
    setGoals(prev => {
      setUndoStack(s => [...s.slice(-19), { type: "goals", value: prev }]);
      return typeof updater === "function" ? updater(prev) : updater;
    });
  }, []);
  const setWishlistWithUndo = useCallback((updater) => {
    setWishlist(prev => {
      setUndoStack(s => [...s.slice(-19), { type: "wishlist", value: prev }]);
      return typeof updater === "function" ? updater(prev) : updater;
    });
  }, []);

  const undo = useCallback(() => {
    setUndoStack(stack => {
      if (stack.length === 0) return stack;
      const last = stack[stack.length - 1];
      if (last.type === "month") {
        skipFirstMonthSave.current = false;
        setMonth(last.value);
      } else if (last.type === "goals") {
        skipFirstGoalsSave.current = false;
        setGoals(last.value);
      } else if (last.type === "wishlist") {
        skipFirstWishlistSave.current = false;
        setWishlist(last.value);
      }
      return stack.slice(0, -1);
    });
  }, []);

  const saveNow = useCallback(async () => {
    if (monthSaveTimer.current) { clearTimeout(monthSaveTimer.current); monthSaveTimer.current = null; }
    if (goalsSaveTimer.current) { clearTimeout(goalsSaveTimer.current); goalsSaveTimer.current = null; }
    if (wishlistSaveTimer.current) { clearTimeout(wishlistSaveTimer.current); wishlistSaveTimer.current = null; }
    pendingMonthSave.current = null;
    pendingGoalsSave.current = null;
    pendingWishlistSave.current = null;
    setSaveState("saving");
    const m = monthRef.current;
    if (m) {
      await saveMonthDoc(m);
      setAllMonths(prev => {
        const others = prev.filter(x => x.key !== m.key);
        return [...others, m];
      });
    }
    await saveGoalsDoc(goalsRef.current);
    await saveWishlistDoc(wishlistRef.current);
    setSaveState("saved");
  }, []);

  const addNextMonth = useCallback(async () => {
    // Flush pending edits to the CURRENT month so carry-forward uses fresh data.
    await flushPendingSaves();
    // Use the live current month as the source, not a stale allMonths lookup.
    const prev = monthRef.current;
    if (!prev) return;
    const key = nextMonthKey(prev.key);
    if (monthsIndex.includes(key)) { switchMonth(key); return; }
    const nm = buildNextMonth(prev, key, allMonthsRef.current);
    await saveMonthDoc(nm);
    const keys = [...monthsIndex, key].sort();
    setMonthsIndex(keys);
    setAllMonths(prevAll => [...prevAll, nm]);
    skipFirstMonthSave.current = true;
    setCurrentKey(key);
    setMonth(nm);
  }, [monthsIndex, switchMonth, flushPendingSaves]);

  // Build a blank historical month template using an existing month's category structure.
  // Unlike buildNextMonth, values are NOT carried — user is entering historical data.
  const buildBlankMonthFromTemplate = useCallback((templateMonth, key) => {
    return {
      key,
      income: { expected: null, actual: null },
      fixed: (templateMonth?.fixed || []).filter(r => !r.emiPlan).map(r => ({ name: r.name, budget: null, actual: null, paidMark: false })),
      cc: (templateMonth?.cc || []).map(r => ({ name: r.name, due: null, paid: null, remarks: "", paidMark: false })),
      variable: (templateMonth?.variable || []).map(r => ({ name: r.name, budget: null, actual: null })),
      debts: [],
      lent: [],
      investments: [],
      savingsBalance: { opening: 0, withdrawals: null }
    };
  }, []);

  const addPastMonth = useCallback(async (targetKey) => {
    // Validate format YYYY-MM
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(targetKey)) {
      alert("Please enter a month in the format YYYY-MM, e.g. 2025-03");
      return false;
    }
    // Already exists?
    if (monthsIndex.includes(targetKey)) {
      switchMonth(targetKey);
      return true;
    }
    await flushPendingSaves();
    // Use the earliest existing month as the template for category structure.
    const sorted = [...allMonthsRef.current].sort((a, b) => a.key.localeCompare(b.key));
    const template = sorted[0] || monthRef.current;
    const nm = buildBlankMonthFromTemplate(template, targetKey);
    await saveMonthDoc(nm);
    const keys = [...monthsIndex, targetKey].sort();
    setMonthsIndex(keys);
    setAllMonths(prevAll => [...prevAll, nm]);
    skipFirstMonthSave.current = true;
    setCurrentKey(targetKey);
    setMonth(nm);
    return true;
  }, [monthsIndex, switchMonth, flushPendingSaves, buildBlankMonthFromTemplate]);

  // Delete a month by key. Firestore + local state. Refuses to delete the last remaining month.
  // After delete, switches to the immediately-previous month by key (or next if it was the earliest).
  // Re-runs cascade from the fallback month so opening balances stay consistent.
  const deleteMonth = useCallback(async (key) => {
    // Guard: must have at least 2 months
    const currentKeys = monthsIndex;
    if (currentKeys.length <= 1) return false;
    // Flush any pending edits first
    await flushPendingSaves();
    // Delete from Firestore
    const ok = await deleteMonthDoc(key);
    if (!ok) return false;
    // Update local state
    const remainingKeys = currentKeys.filter(k => k !== key).sort();
    const remainingMonths = allMonthsRef.current.filter(m => m.key !== key);
    setMonthsIndex(remainingKeys);
    setAllMonths(remainingMonths);
    // If we deleted the currently-viewed month, switch to the immediately-previous by key
    // (fallback to the earliest remaining if the deleted one was the earliest)
    if (monthRef.current?.key === key) {
      const idx = currentKeys.indexOf(key);
      const fallbackKey = idx > 0 ? currentKeys[idx - 1] : remainingKeys[0];
      const fallback = remainingMonths.find(m => m.key === fallbackKey);
      if (fallback) {
        skipFirstMonthSave.current = true;
        setCurrentKey(fallbackKey);
        setMonth(fallback);
      }
    }
    // Re-cascade from the earliest remaining month so opening balances are consistent.
    // Use the current allMonthsRef, which the setAllMonths above will populate on next tick;
    // we call cascade with the earliest key to walk the full chain.
    if (remainingKeys.length > 0) {
      // We need to wait for the state update to propagate to the ref
      setTimeout(() => {
        cascadeOpeningBalances(remainingKeys[0]).catch(e => console.error("post-delete cascade failed", e));
      }, 50);
    }
    return true;
  }, [monthsIndex, flushPendingSaves, cascadeOpeningBalances]);

  const [showPastMonthModal, setShowPastMonthModal] = useState(false);
  const [pastMonthInput, setPastMonthInput] = useState("");
  const [pastMonthYear, setPastMonthYear] = useState("");
  const [pastMonthMonth, setPastMonthMonth] = useState("");
  const [confirmDeleteMonth, setConfirmDeleteMonth] = useState(false);

  if (loading || !month) return <div className="app-loading">Loading your budget…</div>;

  const sortedMonths = [...allMonths].sort((a, b) => a.key.localeCompare(b.key));
  const last3 = sortedMonths.slice(-3);
  const savingsList = last3.map(m => computeMonth(m, allMonths).savingsActual);
  const avgSavings = savingsList.length ? savingsList.reduce((s, v) => s + v, 0) / savingsList.length : null;

  return (
    <div className="app-root">
      <style>{`
        .app-root {
          --bg: #131822;
          --surface: #1B2231;
          --surface-2: #232B3B;
          --border: #1E2632;
          --border-strong: #2A3446;
          --text: #F0F4FA;
          --text-mid: #DDE3EE;
          --text-dim: #8B99B0;
          --text-faint: #7A8299;
          --accent: #6BCEB6;
          --accent-soft: rgba(107,206,182,0.12);
          --accent-border: rgba(107,206,182,0.28);
          --pos: #6BCEB6;
          --neg: #E88B7A;
          --warn: #E8C46B;
          --sheet-bg: #1B2231;
          --sheet-header-bg: #232B3B;
          --input-focus-bg: rgba(107,206,182,0.05);
          font-family: 'Inter', -apple-system, 'Segoe UI', system-ui, sans-serif;
          color: var(--text-mid);
          background: var(--bg);
          padding: 12px;
          border-radius: 10px;
          max-width: 1200px;
          margin: 0 auto;
        }
        .app-loading { padding: 40px; text-align: center; color: var(--text-dim); background: var(--bg); border-radius: 10px; font-family: 'Inter', sans-serif; }
        .topbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; padding: 4px 6px 12px; border-bottom: 1px solid var(--border); }
        .topbar h1 { font-size: 15px; font-weight: 500; color: var(--text); margin: 0; flex: 1 1 100%; letter-spacing: 0.01em; }
        .tabs-row { display: flex; flex-wrap: wrap; gap: 22px; flex: 1 1 auto; margin-top: 4px; }
        .tabbtn { border: none; background: transparent; padding: 6px 0; font-size: 12.5px; cursor: pointer; font-family: inherit; color: var(--text-dim); border-bottom: 1px solid transparent; transition: color 0.15s; }
        .tabbtn:hover { color: var(--text-mid); }
        .tabbtn.active { color: var(--text); border-bottom-color: var(--accent); }
        .monthselect { padding: 6px 10px; font-size: 12.5px; border: 1px solid var(--border-strong); border-radius: 6px; font-family: inherit; background: var(--surface); color: var(--text-mid); }
        .newmonthbtn { border: 1px solid var(--accent-border); background: var(--accent-soft); color: var(--accent); padding: 6px 12px; font-size: 12.5px; border-radius: 6px; cursor: pointer; font-family: inherit; }
        .newmonthbtn:hover { background: rgba(107,206,182,0.18); }
        .signoutbtn { border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-dim); padding: 6px 12px; font-size: 12.5px; border-radius: 6px; cursor: pointer; font-family: inherit; }
        .signoutbtn:hover { color: var(--text-mid); border-color: var(--text-faint); }
        .signoutbtn:disabled { opacity: 0.4; cursor: not-allowed; }
        .savebtn { border: 1px solid var(--accent); background: var(--accent); color: var(--bg); padding: 6px 14px; font-size: 12.5px; border-radius: 6px; cursor: pointer; font-family: inherit; font-weight: 500; }
        .savebtn:hover { background: #5EB8A2; border-color: #5EB8A2; }
        .muted { color: var(--text-faint); }
        .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; cursor: pointer; transition: border-color 0.15s; }
        .stat-card:hover { border-color: var(--border-strong); }
        .stat-hero { grid-column: span 2; background: var(--surface); border-color: var(--accent-border); }
        .stat-value-big { font-size: 28px; font-weight: 500; color: var(--text); letter-spacing: -0.02em; }
        .stat-value-big.pos { color: var(--pos); }
        .stat-value-big.neg { color: var(--neg); }
        .stat-sub { font-size: 11px; color: var(--text-dim); margin-top: 4px; }
        .stat-sub.pos { color: var(--pos); }
        .stat-sub.neg { color: var(--neg); }
        .insights-list { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
        .insight { display: flex; align-items: center; gap: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; font-size: 12.5px; color: var(--text-mid); }
        .insight-good { border-left: 2px solid var(--pos); }
        .insight-warn { border-left: 2px solid var(--warn); }
        .insight-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
        .insight-good .insight-dot { background: var(--pos); }
        .insight-warn .insight-dot { background: var(--warn); }
        .savebadge { font-size: 11px; color: var(--text-faint); min-width: 60px; text-align: right; }
        .month-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .sheet-scroll { overflow-x: auto; border: 1px solid var(--border); background: var(--sheet-bg); border-radius: 8px; }
        table.sheet { border-collapse: collapse; width: 100%; min-width: 480px; font-size: 12.5px; color: var(--text-mid); }
        .letter-row .corner, .letter-row .letter { background: var(--sheet-header-bg); border: 1px solid var(--border); text-align: center; font-weight: 500; color: var(--text-dim); padding: 4px 0; position: sticky; top: 0; z-index: 2; font-size: 11px; letter-spacing: 0.02em; }
        .letter-row .corner { width: 30px; }
        .letter-row .letter { min-width: 92px; }
        .rownum { background: var(--sheet-header-bg); border: 1px solid var(--border); text-align: center; color: var(--text-dim); font-weight: 500; width: 30px; font-size: 11px; }
        .section-row .section-title { background: var(--surface-2); color: var(--text); font-weight: 500; padding: 10px 12px; border: 1px solid var(--border-strong); letter-spacing: 0.05em; font-size: 14.5px; text-transform: uppercase; }
        .colhead-row .colhead { background: var(--surface-2); font-weight: 500; border: 1px solid var(--border); padding: 6px 10px; white-space: nowrap; color: var(--text-mid); font-size: 11.5px; }
        .cell { border: 1px solid var(--border); padding: 3px 8px; height: 28px; white-space: nowrap; }
        .cell-strong { font-weight: 500; color: var(--text); }
        .total-row .cell { background: var(--surface-2); }
        .grand-total-row .cell { background: var(--accent-soft); color: var(--text); font-weight: 500; border-color: var(--accent-border); }
        .paid-row .cell { background: rgba(107,206,182,0.05); }
        .paidmark { accent-color: var(--accent); width: 15px; height: 15px; cursor: pointer; vertical-align: middle; }
        .payment-history-block { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 8px; }
        .payment-history-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12.5px; }
        .payment-history-name { font-weight: 500; color: var(--text); }
        .payment-history-total { color: var(--text-dim); font-size: 12px; }
        .payment-history-list { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); display: flex; flex-direction: column; gap: 3px; }
        .payment-history-item { display: grid; grid-template-columns: 110px 1fr auto; gap: 12px; font-size: 12px; color: var(--text-mid); padding: 3px 0; }
        .payment-history-month { color: var(--text-dim); }
        .payment-history-fixed { color: var(--text-mid); }
        .payment-history-amount { color: var(--text); font-weight: 500; text-align: right; font-variant-numeric: tabular-nums; }
        .debt-link-select { border: 1px solid var(--border-strong); background: var(--surface); color: var(--text-mid); padding: 3px 6px; border-radius: 3px; font-family: inherit; font-size: 11px; max-width: 130px; }
        .diagnostic-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-top: 12px; font-size: 12px; color: var(--text-mid); }
        .diagnostic-row { display: grid; grid-template-columns: 180px 1fr; gap: 12px; padding: 3px 0; font-variant-numeric: tabular-nums; }
        .diagnostic-row .k { color: var(--text-dim); }
        .diagnostic-row .v { color: var(--text-mid); text-align: right; }
        .diagnostic-warn { color: var(--warn); font-size: 11.5px; margin-top: 6px; padding: 6px 8px; border-left: 2px solid var(--warn); background: rgba(232,196,107,0.05); }
        .home-month-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; font-size: 12.5px; color: var(--text-dim); }
        .home-month-header b { color: var(--text); font-weight: 500; }
        .empty-month-badge { background: rgba(232,196,107,0.15); color: var(--warn); font-size: 11px; padding: 3px 9px; border-radius: 10px; font-weight: 500; }
        .empty-month-warning { background: rgba(232,196,107,0.08); border: 1px solid rgba(232,196,107,0.3); color: var(--warn); padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 12.5px; line-height: 1.5; }
        .deletebtn { border: 1px solid var(--neg); background: transparent; color: var(--neg); padding: 6px 12px; font-size: 12.5px; border-radius: 6px; cursor: pointer; font-family: inherit; }
        .deletebtn:hover:not(:disabled) { background: rgba(232,139,122,0.08); }
        .deletebtn:disabled { opacity: 0.35; cursor: not-allowed; }
        .month-picker-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
        .month-picker-row select { padding: 10px 12px; background: var(--bg); border: 1px solid var(--border-strong); border-radius: 6px; color: var(--text-mid); font-family: inherit; font-size: 13px; }
        .future-month-notice { background: rgba(232,196,107,0.08); border: 1px solid rgba(232,196,107,0.3); color: var(--warn); padding: 8px 12px; border-radius: 6px; margin-top: 10px; font-size: 12px; }
        .month-option-future { color: var(--warn); }
        .editin { border: none; background: transparent; font-family: inherit; font-size: 12.5px; width: 100%; padding: 4px 3px; outline-offset: 0; color: var(--text-mid); }
        .editin:focus { outline: 1.5px solid var(--accent); background: var(--input-focus-bg); color: var(--text); border-radius: 3px; }
        .edit-text { min-width: 90px; }
        .edit-date { min-width: 120px; color-scheme: dark; }
        .numwrap { display: flex; align-items: center; }
        .rupee { color: var(--text-faint); font-size: 11.5px; margin-right: 2px; }
        .pctsign { color: var(--text-faint); font-size: 11.5px; margin-left: 2px; }
        .edit-num { text-align: right; min-width: 55px; }
        .badge { display: inline-block; padding: 2px 9px; border-radius: 10px; font-size: 11px; font-weight: 500; white-space: nowrap; }
        .badge-green { background: rgba(107,206,182,0.15); color: var(--accent); }
        .badge-amber { background: rgba(232,196,107,0.15); color: var(--warn); }
        .badge-red { background: rgba(232,139,122,0.15); color: var(--neg); }
        .badge-gray { background: rgba(122,136,160,0.15); color: var(--text-dim); }
        .rowbtn { border: 1px solid var(--border-strong); background: var(--surface); width: 22px; height: 22px; line-height: 1; border-radius: 4px; cursor: pointer; color: var(--neg); font-size: 12px; }
        .rowbtn:hover { border-color: var(--neg); }
        .rowbtn.addbtn { color: var(--accent); border-color: var(--accent-border); width: auto; padding: 4px 12px; font-size: 11.5px; }
        .rowbtn.addbtn:hover { background: var(--accent-soft); }
        .history { background: var(--surface); border: 1px solid var(--border); padding: 16px; border-radius: 8px; }
        .stat-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 20px; }
        .stat-label { font-size: 11px; color: var(--text-dim); margin-bottom: 4px; }
        .stat-value { font-size: 18px; font-weight: 500; color: var(--text); }
        .stat-value.pos { color: var(--pos); }
        .stat-value.neg { color: var(--neg); }
        .hist-heading { font-size: 12px; font-weight: 500; color: var(--text); margin: 20px 0 10px; letter-spacing: 0.05em; text-transform: uppercase; }
        .hist-heading-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 20px 0 10px; flex-wrap: wrap; }
        .hist-heading-row .hist-heading { margin: 0; }
        .chart-box { background: var(--surface); border-radius: 6px; padding: 4px; }
        .hist-table { min-width: 420px; }
        .empty-state { padding: 30px; text-align: center; color: var(--text-dim); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; }
        .goal-note { font-size: 11.5px; color: var(--text-dim); margin-bottom: 10px; background: var(--surface); border: 1px solid var(--border); padding: 8px 12px; border-radius: 6px; }
        .progress-track { position: relative; background: var(--surface-2); border-radius: 8px; height: 16px; width: 100%; min-width: 90px; overflow: hidden; }
        .progress-fill { background: var(--accent); height: 100%; }
        .progress-label { position: absolute; top: 0; left: 6px; font-size: 10px; line-height: 16px; color: var(--text); font-weight: 500; }
        .wishlist-detail { background: var(--surface-2); border: 1px solid var(--border); padding: 14px 16px; border-radius: 6px; }
        .wishlist-detail-title { font-size: 12.5px; font-weight: 500; color: var(--text); margin-bottom: 4px; letter-spacing: 0.02em; }
        .wishlist-detail-hint { font-size: 11.5px; color: var(--text-dim); margin: 0 0 10px; }
        .wishlist-detail-label { font-size: 11px; color: var(--text-dim); margin-bottom: 4px; }
        .wishlist-critical { background: rgba(232,196,107,0.08); border: 1px solid rgba(232,196,107,0.3); padding: 12px 14px; border-radius: 6px; margin-bottom: 14px; }
        .wishlist-check { display: block; font-size: 12px; margin: 5px 0; cursor: pointer; color: var(--text-mid); }
        .wishlist-check input { margin-right: 8px; vertical-align: -1px; accent-color: var(--accent); }
        .wishlist-reasons { margin: 0 0 8px; padding-left: 18px; }
        .wishlist-reasons li { font-size: 12px; margin: 3px 0; }
        .reason-good { color: var(--pos); }
        .reason-warn { color: var(--warn); }
        .reason-bad { color: var(--neg); }
        .funding-list { display: flex; flex-direction: column; gap: 8px; }
        .funding-scenario { background: var(--surface); border: 1px solid var(--border); padding: 12px 14px; border-radius: 6px; border-left-width: 2px; }
        .funding-good { border-left-color: var(--pos); }
        .funding-warn { border-left-color: var(--warn); }
        .funding-bad { border-left-color: var(--neg); }
        .funding-recommended { background: var(--accent-soft); border-color: var(--accent-border); }
        .funding-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .funding-title { font-size: 13px; font-weight: 500; color: var(--text); }
        .funding-recommended-badge { background: var(--accent); color: var(--bg); font-size: 10px; padding: 2px 9px; border-radius: 10px; font-weight: 500; }
        .funding-steps { margin: 4px 0 8px; padding-left: 18px; font-size: 12px; color: var(--text-mid); }
        .funding-steps li { margin: 3px 0; }
        .funding-after { display: flex; flex-wrap: wrap; gap: 14px; font-size: 11.5px; color: var(--text-dim); margin-bottom: 10px; }
        .funding-after b { color: var(--text); font-weight: 500; }
        .funding-apply { background: transparent; border: 1px solid var(--accent); color: var(--accent); padding: 5px 14px; font-size: 12px; border-radius: 5px; cursor: pointer; font-family: inherit; font-weight: 500; }
        .funding-apply:hover { background: var(--accent-soft); }
        .modal-backdrop { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(8,12,20,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; padding: 16px; }
        .modal { background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px; padding: 22px 24px; max-width: 480px; width: 100%; color: var(--text-mid); }
        .modal h3 { color: var(--text) !important; }
        .modal p { color: var(--text-mid) !important; }
        .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
        @media (max-width: 640px) {
          table.sheet { font-size: 11.5px; }
          .letter-row .letter { min-width: 76px; }
          .topbar h1 { font-size: 13px; }
        }
      `}</style>

      <div className="topbar">
        <h1>Budgetify💰</h1>
        <div className="tabs-row">
          {TABS.map(t => (
            <button key={t.id} className={"tabbtn" + (view === t.id ? " active" : "")} onClick={() => setView(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="month-controls">
          <select className="monthselect" value={currentKey} onChange={e => switchMonth(e.target.value)}>
            {monthsIndex.map(k => {
              const isFuture = k > todayKey();
              return <option key={k} value={k} className={isFuture ? "month-option-future" : undefined}>
                {monthLabel(k)}{isFuture ? " (future)" : ""}
              </option>;
            })}
          </select>
          <button className="newmonthbtn" onClick={addNextMonth}>+ Next month</button>
          <button
            className="signoutbtn"
            onClick={() => {
              const now = new Date();
              setPastMonthYear(String(now.getFullYear()));
              setPastMonthMonth(String(now.getMonth() + 1).padStart(2, "0"));
              setShowPastMonthModal(true);
            }}
            title="Add any month (past or future)"
          >
            + Add a month
          </button>
          <button
            className="deletebtn"
            onClick={() => setConfirmDeleteMonth(true)}
            disabled={monthsIndex.length <= 1}
            title={monthsIndex.length <= 1 ? "Can't delete — only one month left" : "Delete the currently selected month"}
          >
            🗑 Delete month
          </button>
          <button className="signoutbtn" onClick={undo} disabled={undoStack.length === 0} title="Undo last change">↶ Undo</button>
          <button className="savebtn" onClick={saveNow} title="Force save right now">💾 Save</button>
          <span className="savebadge">{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}</span>
          <button className="signoutbtn" onClick={() => signOut(auth)}>Sign out</button>
        </div>
      </div>

      {view === "home" && <HomeTab month={month} allMonths={allMonths} goals={goals} wishlist={wishlist} onGo={setView} />}
      {view === "expenses" && <ExpensesTab month={month} setMonth={setMonthWithUndo} allMonths={allMonths} />}
      {view === "savings" && <SavingsTab month={month} setMonth={setMonthWithUndo} allMonths={allMonths} />}
      {view === "debt" && <DebtTab month={month} setMonth={setMonthWithUndo} allMonths={allMonths} />}
      {view === "lent" && <LentTab month={month} setMonth={setMonthWithUndo} allMonths={allMonths} />}
      {view === "investments" && <InvestmentsTab month={month} setMonth={setMonthWithUndo} allMonths={allMonths} />}
      {view === "goals" && (
        <GoalsTab goals={goals} setGoals={setGoalsWithUndo} avgSavings={avgSavings} monthsCounted={last3.length} />
      )}
      {view === "wishlist" && (
        <WishlistTab
          wishlist={wishlist}
          setWishlist={setWishlistWithUndo}
          month={month}
          setMonth={setMonthWithUndo}
          goals={goals}
          setGoals={setGoalsWithUndo}
          allMonths={allMonths}
          saveNow={saveNow}
        />
      )}
      {view === "history" && <HistoryTab allMonths={allMonths} />}

      {showPastMonthModal && (() => {
        const targetKey = pastMonthYear && pastMonthMonth ? `${pastMonthYear}-${pastMonthMonth}` : "";
        const isFuture = targetKey && targetKey > todayKey();
        const alreadyExists = targetKey && monthsIndex.includes(targetKey);
        const currentYear = new Date().getFullYear();
        const years = [];
        for (let y = currentYear - 10; y <= currentYear + 10; y++) years.push(y);
        const months = [
          { v: "01", l: "January" }, { v: "02", l: "February" }, { v: "03", l: "March" },
          { v: "04", l: "April" }, { v: "05", l: "May" }, { v: "06", l: "June" },
          { v: "07", l: "July" }, { v: "08", l: "August" }, { v: "09", l: "September" },
          { v: "10", l: "October" }, { v: "11", l: "November" }, { v: "12", l: "December" }
        ];
        return (
          <div className="modal-backdrop" onClick={() => setShowPastMonthModal(false)}>
            <div className="modal" onClick={e => e.stopPropagation()}>
              <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Add a month</h3>
              <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-mid)" }}>
                Pick the month you want to add. It'll be created as a blank sheet using your existing category names.
              </p>
              <div className="month-picker-row">
                <select value={pastMonthYear} onChange={e => setPastMonthYear(e.target.value)}>
                  <option value="">Year…</option>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
                <select value={pastMonthMonth} onChange={e => setPastMonthMonth(e.target.value)}>
                  <option value="">Month…</option>
                  {months.map(m => <option key={m.v} value={m.v}>{m.l}</option>)}
                </select>
              </div>
              {alreadyExists && (
                <div className="future-month-notice" style={{ borderColor: "rgba(107,206,182,0.3)", background: "rgba(107,206,182,0.06)", color: "var(--accent)" }}>
                  This month already exists. Clicking Create will just switch to it.
                </div>
              )}
              {isFuture && !alreadyExists && (
                <div className="future-month-notice">
                  ⚠ You're adding a <b>future month</b> ({monthLabel(targetKey)}). This is fine for planning, but it'll be empty. Confirm you want to proceed.
                </div>
              )}
              <p style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 10 }}>
                Opening balance is set to ₹0. Enter it manually on the Savings tab. Adding a month does not change the balance chain of other months automatically.
              </p>
              <div className="modal-actions">
                <button className="signoutbtn" onClick={() => setShowPastMonthModal(false)}>Cancel</button>
                <button
                  className="savebtn"
                  onClick={async () => {
                    if (!targetKey) return;
                    const ok = await addPastMonth(targetKey);
                    if (ok) setShowPastMonthModal(false);
                  }}
                  disabled={!targetKey}
                >
                  {alreadyExists ? "Switch to it" : (isFuture ? "Yes, create future month" : "Create month")}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmDeleteMonth && (
        <div className="modal-backdrop" onClick={() => setConfirmDeleteMonth(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px", color: "var(--text)" }}>Delete {monthLabel(currentKey)}?</h3>
            <p style={{ fontSize: 13, lineHeight: 1.5, color: "var(--text-mid)" }}>
              This will permanently delete the {monthLabel(currentKey)} month from your data, including:
            </p>
            <ul style={{ fontSize: 12.5, lineHeight: 1.6, color: "var(--text-mid)", marginTop: 6 }}>
              <li>{(month.fixed || []).length} fixed expense{(month.fixed || []).length === 1 ? "" : "s"}, {(month.variable || []).length} variable expense{(month.variable || []).length === 1 ? "" : "s"}, {(month.cc || []).length} credit card{(month.cc || []).length === 1 ? "" : "s"}</li>
              <li>{(month.debts || []).length} debt row{(month.debts || []).length === 1 ? "" : "s"}, {(month.lent || []).length} lent-out entr{(month.lent || []).length === 1 ? "y" : "ies"}, {(month.investments || []).length} investment{(month.investments || []).length === 1 ? "" : "s"}</li>
              <li>Income, savings balance, wishlist withdrawals for this month</li>
            </ul>
            <p style={{ fontSize: 12, color: "var(--warn)", marginTop: 10 }}>
              ⚠ This cannot be undone. Other months are not affected, but opening-balance chains will be re-computed.
            </p>
            <div className="modal-actions">
              <button className="signoutbtn" onClick={() => setConfirmDeleteMonth(false)}>Cancel</button>
              <button
                className="deletebtn"
                onClick={async () => {
                  const ok = await deleteMonth(currentKey);
                  if (ok) setConfirmDeleteMonth(false);
                }}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Root: auth gate ---------------- */

export default function Root() {
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthChecked(true);
    });
    return unsub;
  }, []);

  if (!authChecked) return <div className="app-loading">Loading…</div>;
  if (!user) return <Login />;
  return <PlannerApp />;
}
