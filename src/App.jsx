import { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer
} from "recharts";
import { db, auth } from "./firebase";
import { collection, getDocs, doc, getDoc, setDoc } from "firebase/firestore";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";

/* ---------------- helpers ---------------- */

function letters(n) {
  return Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i));
}

function fmt(n) {
  if (n === null || n === undefined || isNaN(n) || n === 0) return "-";
  const abs = Math.abs(Math.round(n)).toLocaleString("en-IN");
  return n < 0 ? `(₹${abs})` : `₹${abs}`;
}
function fmtPlain(n) {
  if (n === null || n === undefined || isNaN(n)) return "";
  return Math.round(n).toLocaleString("en-IN");
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

/* ---------------- seed / carry-forward ---------------- */

function seedMonth() {
  const now = new Date();
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return {
    key,
    income: { expected: null, actual: null },
    fixed: [
      { name: "Rent", budget: null, actual: null },
      { name: "Groceries", budget: null, actual: null }
    ],
    cc: [
      { name: "Card 1", due: null, paid: null, remarks: "" }
    ],
    variable: [
      { name: "Dining Out", budget: null, actual: null }
    ],
    debts: [],
    investments: [],
    savingsBalance: { opening: 0, withdrawals: null }
  };
}

function buildNextMonth(prev, key) {
  const prevComputed = computeMonth(prev);
  return {
    key,
    income: { expected: prev.income.expected, actual: null },
    fixed: prev.fixed.map(r => ({ name: r.name, budget: r.budget, actual: null })),
    cc: prev.cc.map(r => ({ name: r.name, due: r.due, paid: null, remarks: "" })),
    variable: prev.variable.map(r => ({ name: r.name, budget: r.budget, actual: null })),
    debts: prev.debts.map(r => ({ name: r.name, outstanding: r.outstanding })),
    investments: (prev.investments || []).map(r => ({ ...r })),
    savingsBalance: { opening: prevComputed.closingBalance, withdrawals: null }
  };
}

function computeMonth(m) {
  const fixedBudget = m.fixed.reduce((s, r) => s + num(r.budget), 0);
  const fixedActual = m.fixed.reduce((s, r) => s + num(r.actual), 0);
  const ccDue = m.cc.reduce((s, r) => s + num(r.due), 0);
  const ccPaid = m.cc.reduce((s, r) => s + num(r.paid), 0);
  const varBudget = m.variable.reduce((s, r) => s + num(r.budget), 0);
  const varActual = m.variable.reduce((s, r) => s + num(r.actual), 0);
  const debtTotal = m.debts.reduce((s, r) => s + num(r.outstanding), 0);
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
  const withdrawals = num(sb.withdrawals);
  const closingBalance = openingBalance + savingsActual - withdrawals;

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

  return {
    fixedBudget, fixedActual, ccDue, ccPaid, varBudget, varActual, debtTotal,
    expBudget, expActual, savingsExpected, savingsActual, rateExpected, rateActual,
    nonCardActual: fixedActual + varActual, nonCardBudget: fixedBudget + varBudget,
    openingBalance, withdrawals, closingBalance, budgetAccuracy,
    investedTotal, currentValueTotal, investmentGain, investmentGainPct
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
function EditNum({ value, onChange }) {
  return (
    <div className="numwrap">
      <span className="rupee">₹</span>
      <input
        className="editin edit-num"
        type="text"
        inputMode="decimal"
        value={value === null || value === undefined ? "" : fmtPlain(value)}
        placeholder="-"
        onChange={e => {
          const raw = e.target.value.replace(/[^\d.]/g, "");
          onChange(raw === "" ? null : parseFloat(raw));
        }}
      />
    </div>
  );
}
function EditPct({ value, onChange }) {
  return (
    <div className="numwrap">
      <input
        className="editin edit-num"
        type="text"
        inputMode="decimal"
        value={value === null || value === undefined ? "" : value}
        placeholder="-"
        onChange={e => {
          const raw = e.target.value.replace(/[^\d.]/g, "");
          onChange(raw === "" ? null : parseFloat(raw));
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

function ExpensesTab({ month, setMonth }) {
  rowCounter = 1;
  const c = computeMonth(month);

  const update = (section, idx, field, value) => {
    setMonth(prev => ({ ...prev, [section]: prev[section].map((r, i) => i === idx ? { ...r, [field]: value } : r) }));
  };
  const addRow = (section, blank) => setMonth(prev => ({ ...prev, [section]: [...prev[section], blank] }));
  const removeRow = (section, idx) => setMonth(prev => ({ ...prev, [section]: prev[section].filter((_, i) => i !== idx) }));

  return (
    <SheetWrap cols={7}>
      <SectionTitle title="FIXED EXPENSES" span={7} />
      <HeaderRow labels={["Expense", "Budget (₹)", "Actual Paid (₹)", "Variance (₹)", "Status", "", ""]} />
      {month.fixed.map((r, i) => {
        const hasActual = r.actual !== null && r.actual !== undefined;
        const variance = num(r.actual) - num(r.budget);
        const status = expenseStatus(num(r.budget), num(r.actual), hasActual);
        return (
          <tr key={i}>
            <RowNum />
            <Cell><EditText value={r.name} onChange={v => update("fixed", i, "name", v)} /></Cell>
            <Cell align="right"><EditNum value={r.budget} onChange={v => update("fixed", i, "budget", v)} /></Cell>
            <Cell align="right"><EditNum value={r.actual} onChange={v => update("fixed", i, "actual", v)} /></Cell>
            <Cell align="right">{fmt(variance)}</Cell>
            <Cell><span className={badgeClass(status)}>{status}</span></Cell>
            <Cell />
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
        <Cell /><Cell />
        <Cell align="center"><button className="rowbtn addbtn" onClick={() => addRow("fixed", { name: "New expense", budget: null, actual: null })}>+</button></Cell>
      </tr>

      <SectionTitle title="CREDIT CARD BILLS" span={7} />
      <HeaderRow labels={["Card", "Amount Due", "Paid", "Variance (₹)", "Status", "Remarks", ""]} />
      {month.cc.map((r, i) => {
        const hasPaid = r.paid !== null && r.paid !== undefined;
        const variance = num(r.paid) - num(r.due);
        const status = ccStatus(num(r.due), num(r.paid), hasPaid);
        return (
          <tr key={i}>
            <RowNum />
            <Cell><EditText value={r.name} onChange={v => update("cc", i, "name", v)} /></Cell>
            <Cell align="right"><EditNum value={r.due} onChange={v => update("cc", i, "due", v)} /></Cell>
            <Cell align="right"><EditNum value={r.paid} onChange={v => update("cc", i, "paid", v)} /></Cell>
            <Cell align="right">{fmt(variance)}</Cell>
            <Cell><span className={badgeClass(status)}>{status}</span></Cell>
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
        <Cell /><Cell />
        <Cell align="center"><button className="rowbtn addbtn" onClick={() => addRow("cc", { name: "New card", due: null, paid: null, remarks: "" })}>+</button></Cell>
      </tr>

      <SectionTitle title="VARIABLE EXPENSES" span={7} />
      <HeaderRow labels={["Expense", "Budget (₹)", "Actual Paid (₹)", "Remaining (₹)", "Variance (₹)", "Status", ""]} />
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
        <Cell />
        <Cell align="center"><button className="rowbtn addbtn" onClick={() => addRow("variable", { name: "New expense", budget: null, actual: null })}>+</button></Cell>
      </tr>

      <tr className="grand-total-row">
        <RowNum />
        <Cell strong>TOTAL EXPENSES</Cell>
        <Cell align="right" strong>{fmt(c.expBudget)}</Cell>
        <Cell align="right" strong>{fmt(c.expActual)}</Cell>
        <Cell align="right" strong>{fmt(c.expActual - c.expBudget)}</Cell>
        <Cell /><Cell /><Cell />
      </tr>
    </SheetWrap>
  );
}

/* ---------------- Savings tab ---------------- */

function SavingsTab({ month, setMonth }) {
  rowCounter = 1;
  const c = computeMonth(month);
  const updateIncome = (field, value) => setMonth(prev => ({ ...prev, income: { ...prev.income, [field]: value } }));
  const updateSB = (field, value) => setMonth(prev => ({ ...prev, savingsBalance: { ...(prev.savingsBalance || { opening: 0, withdrawals: null }), [field]: value } }));

  return (
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
      <tr className="grand-total-row">
        <RowNum />
        <Cell strong>Closing Balance</Cell>
        <Cell align="right" strong>{fmt(c.closingBalance)}</Cell>
        <Cell /><Cell />
      </tr>
    </SheetWrap>
  );
}

/* ---------------- Debt tab ---------------- */

function DebtTab({ month, setMonth }) {
  rowCounter = 1;
  const c = computeMonth(month);
  const update = (idx, field, value) => setMonth(prev => ({ ...prev, debts: prev.debts.map((r, i) => i === idx ? { ...r, [field]: value } : r) }));
  const addRow = () => setMonth(prev => ({ ...prev, debts: [...prev.debts, { name: "New creditor", outstanding: null }] }));
  const removeRow = idx => setMonth(prev => ({ ...prev, debts: prev.debts.filter((_, i) => i !== idx) }));

  return (
    <SheetWrap cols={3}>
      <SectionTitle title="DEBT OUTSTANDING" span={3} />
      <HeaderRow labels={["Creditor", "Outstanding (₹)", ""]} />
      {month.debts.map((r, i) => (
        <tr key={i}>
          <RowNum />
          <Cell><EditText value={r.name} onChange={v => update(i, "name", v)} /></Cell>
          <Cell align="right"><EditNum value={r.outstanding} onChange={v => update(i, "outstanding", v)} /></Cell>
          <Cell align="center"><button className="rowbtn" onClick={() => removeRow(i)}>×</button></Cell>
        </tr>
      ))}
      <tr className="total-row">
        <RowNum />
        <Cell strong>Total Debt</Cell>
        <Cell align="right" strong>{fmt(c.debtTotal)}</Cell>
        <Cell align="center"><button className="rowbtn addbtn" onClick={addRow}>+</button></Cell>
      </tr>
    </SheetWrap>
  );
}

/* ---------------- Investments tab ---------------- */

function InvestmentsTab({ month, setMonth }) {
  rowCounter = 1;
  const c = computeMonth(month);
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
  rowCounter = 1;
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

/* ---------------- History tab ---------------- */

function HistoryTab({ allMonths }) {
  const sorted = [...allMonths].sort((a, b) => a.key.localeCompare(b.key));

  const rows = sorted.map(m => {
    const c = computeMonth(m);
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
      cc: Object.fromEntries(m.cc.map(r => [r.name, num(r.paid)]))
    };
  });

  const cardNames = Array.from(new Set(sorted.flatMap(m => m.cc.map(r => r.name))));
  const ccData = rows.map(r => ({ month: r.shortLabel, total: r.cardSpend, ...r.cc }));
  const ccColors = ["#217346", "#2b6cb0", "#c0221f", "#9c6f00", "#6b46c1", "#0f7a3d"];

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
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e2e2" />
            <XAxis dataKey="shortLabel" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} />
            <Legend />
            <Line type="monotone" dataKey="income" name="Income" stroke="#2b6cb0" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="expenses" name="Total expenses" stroke="#c0221f" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="savings" name="Savings" stroke="#217346" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3 className="hist-heading">Expense composition over time</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e2e2" />
            <XAxis dataKey="shortLabel" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} />
            <Legend />
            <Line type="monotone" dataKey="expenses" name="Total expense" stroke="#1a1a1a" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="nonCard" name="Non-card expense" stroke="#2b6cb0" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="cardSpend" name="Card spend" stroke="#c0221f" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3 className="hist-heading">Credit card spend by card</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={ccData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e2e2" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} />
            <Legend />
            {cardNames.map((name, i) => (
              <Bar key={name} dataKey={name} fill={ccColors[i % ccColors.length]} />
            ))}
            <Line type="monotone" dataKey="total" name="Total card spend" stroke="#1a1a1a" strokeWidth={2} dot={{ r: 3 }} />
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
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e2e2" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `₹${(v / 1000).toFixed(1)}k`} />
            <Tooltip formatter={v => fmt(v)} />
            <Legend />
            <Line type="monotone" dataKey="budget" name="Budget" stroke="#9c6f00" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="actual" name="Actual" stroke="#217346" strokeWidth={2} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <h3 className="hist-heading">Savings balance over time</h3>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={rows}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e2e2" />
            <XAxis dataKey="shortLabel" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={v => fmt(v)} />
            <Legend />
            <Line type="monotone" dataKey="balance" name="Closing balance" stroke="#217346" strokeWidth={2} dot={{ r: 3 }} />
            <Line type="monotone" dataKey="withdrawals" name="Withdrawn that month" stroke="#c0221f" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {hasInvestments && (
        <>
          <h3 className="hist-heading">Portfolio value over time</h3>
          <div className="chart-box">
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e2e2" />
                <XAxis dataKey="shortLabel" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                <Tooltip formatter={v => fmt(v)} />
                <Legend />
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
        .login-wrap { min-height: 60vh; display: flex; align-items: center; justify-content: center; font-family: Calibri, Arial, sans-serif; }
        .login-form { background: #fff; border: 1px solid #b7b7b7; border-radius: 6px; padding: 28px 26px; width: 280px; }
        .login-form h2 { margin: 0 0 16px; font-size: 16px; color: #217346; }
        .login-form input { width: 100%; box-sizing: border-box; padding: 8px 10px; margin-bottom: 10px; border: 1px solid #c7c7c7; border-radius: 4px; font-family: inherit; font-size: 13px; }
        .login-form button { width: 100%; padding: 9px; background: #217346; color: #fff; border: none; border-radius: 4px; font-size: 13px; cursor: pointer; }
        .login-form button:disabled { opacity: 0.6; }
        .login-error { color: #c0221f; font-size: 12px; margin-bottom: 10px; }
      `}</style>
      <form className="login-form" onSubmit={handleSubmit}>
        <h2>Financial Planner</h2>
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
  { id: "expenses", label: "Expenses" },
  { id: "savings", label: "Savings" },
  { id: "debt", label: "Debt" },
  { id: "investments", label: "Investments" },
  { id: "goals", label: "Goals" },
  { id: "history", label: "History & trends" }
];

function PlannerApp() {
  const [loading, setLoading] = useState(true);
  const [monthsIndex, setMonthsIndex] = useState([]);
  const [currentKey, setCurrentKey] = useState(null);
  const [month, setMonth] = useState(null);
  const [allMonths, setAllMonths] = useState([]);
  const [goals, setGoals] = useState(defaultGoals());
  const [view, setView] = useState("expenses");
  const [saveState, setSaveState] = useState("idle");

  const monthSaveTimer = useRef(null);
  const goalsSaveTimer = useRef(null);
  const skipFirstMonthSave = useRef(true);
  const skipFirstGoalsSave = useRef(true);

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
      const lastKey = keys[keys.length - 1];
      setCurrentKey(lastKey);
      setMonth(months.find(m => m.key === lastKey));
      const g = await loadGoalsDoc();
      setGoals(g);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!month) return;
    if (skipFirstMonthSave.current) { skipFirstMonthSave.current = false; return; }
    setSaveState("saving");
    if (monthSaveTimer.current) clearTimeout(monthSaveTimer.current);
    monthSaveTimer.current = setTimeout(async () => {
      await saveMonthDoc(month);
      setAllMonths(prev => {
        const others = prev.filter(m => m.key !== month.key);
        return [...others, month];
      });
      setSaveState("saved");
    }, 700);
    return () => clearTimeout(monthSaveTimer.current);
  }, [month]);

  useEffect(() => {
    if (skipFirstGoalsSave.current) { skipFirstGoalsSave.current = false; return; }
    setSaveState("saving");
    if (goalsSaveTimer.current) clearTimeout(goalsSaveTimer.current);
    goalsSaveTimer.current = setTimeout(async () => {
      await saveGoalsDoc(goals);
      setSaveState("saved");
    }, 700);
    return () => clearTimeout(goalsSaveTimer.current);
  }, [goals]);

  const switchMonth = useCallback((key) => {
    skipFirstMonthSave.current = true;
    setCurrentKey(key);
    setMonth(allMonths.find(m => m.key === key));
  }, [allMonths]);

  const addNextMonth = useCallback(async () => {
    const latest = [...monthsIndex].sort().pop();
    const prev = allMonths.find(m => m.key === latest);
    const key = nextMonthKey(latest);
    if (monthsIndex.includes(key)) { switchMonth(key); return; }
    const nm = buildNextMonth(prev, key);
    await saveMonthDoc(nm);
    const keys = [...monthsIndex, key].sort();
    setMonthsIndex(keys);
    setAllMonths(prevAll => [...prevAll, nm]);
    skipFirstMonthSave.current = true;
    setCurrentKey(key);
    setMonth(nm);
  }, [monthsIndex, allMonths, switchMonth]);

  if (loading || !month) return <div className="app-loading">Loading your budget…</div>;

  const sortedMonths = [...allMonths].sort((a, b) => a.key.localeCompare(b.key));
  const last3 = sortedMonths.slice(-3);
  const savingsList = last3.map(m => computeMonth(m).savingsActual);
  const avgSavings = savingsList.length ? savingsList.reduce((s, v) => s + v, 0) / savingsList.length : null;

  return (
    <div className="app-root">
      <style>{`
        .app-root { font-family: Calibri, "Segoe UI", Arial, sans-serif; color: #1a1a1a; background: #f3f3f3; padding: 12px; border-radius: 6px; max-width: 1200px; margin: 0 auto; }
        .app-loading { padding: 40px; text-align: center; font-family: Calibri, Arial, sans-serif; color: #555; }
        .topbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 10px; }
        .topbar h1 { font-size: 15px; font-weight: 700; color: #217346; margin: 0; flex: 1 1 100%; }
        .tabs-row { display: flex; flex-wrap: wrap; gap: 6px; flex: 1 1 auto; }
        .tabbtn { border: 1px solid #b7b7b7; background: #fff; padding: 5px 12px; font-size: 12.5px; cursor: pointer; border-radius: 3px; font-family: inherit; }
        .tabbtn.active { background: #217346; color: #fff; border-color: #217346; }
        .monthselect { padding: 5px 8px; font-size: 12.5px; border: 1px solid #b7b7b7; border-radius: 3px; font-family: inherit; background: #fff; }
        .newmonthbtn { border: 1px solid #217346; background: #eaf6ef; color: #185a35; padding: 5px 10px; font-size: 12.5px; border-radius: 3px; cursor: pointer; font-family: inherit; }
        .signoutbtn { border: 1px solid #c7c7c7; background: #fff; color: #555; padding: 5px 10px; font-size: 12.5px; border-radius: 3px; cursor: pointer; font-family: inherit; }
        .savebadge { font-size: 11px; color: #888; min-width: 60px; text-align: right; }
        .month-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .sheet-scroll { overflow-x: auto; border: 1px solid #b7b7b7; background: #fff; }
        table.sheet { border-collapse: collapse; width: 100%; min-width: 480px; font-size: 12.5px; }
        .letter-row .corner, .letter-row .letter { background: #e8e8e8; border: 1px solid #cfcfcf; text-align: center; font-weight: 700; color: #555; padding: 3px 0; position: sticky; top: 0; z-index: 2; }
        .letter-row .corner { width: 30px; }
        .letter-row .letter { min-width: 92px; }
        .rownum { background: #e8e8e8; border: 1px solid #cfcfcf; text-align: center; color: #555; font-weight: 700; width: 30px; font-size: 11px; }
        .section-row .section-title { background: #217346; color: #fff; font-weight: 700; padding: 5px 8px; border: 1px solid #185a35; letter-spacing: .3px; }
        .colhead-row .colhead { background: #dbe9e0; font-weight: 700; border: 1px solid #cfcfcf; padding: 4px 8px; white-space: nowrap; }
        .cell { border: 1px solid #dcdcdc; padding: 2px 6px; height: 26px; white-space: nowrap; }
        .cell-strong { font-weight: 700; }
        .total-row .cell { background: #f5f7f5; }
        .grand-total-row .cell { background: #ffe9a8; font-weight: 700; }
        .editin { border: none; background: transparent; font-family: inherit; font-size: 12.5px; width: 100%; padding: 3px 2px; outline-offset: 0; }
        .editin:focus { outline: 2px solid #217346; background: #fffef0; }
        .edit-text { min-width: 90px; }
        .edit-date { min-width: 120px; }
        .numwrap { display: flex; align-items: center; }
        .rupee { color: #888; font-size: 11.5px; margin-right: 2px; }
        .pctsign { color: #888; font-size: 11.5px; margin-left: 2px; }
        .edit-num { text-align: right; min-width: 55px; }
        .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; white-space: nowrap; }
        .badge-green { background: #d9f2e3; color: #0f7a3d; }
        .badge-amber { background: #fff2cc; color: #9c6f00; }
        .badge-red { background: #fde2e1; color: #c0221f; }
        .badge-gray { background: #eee; color: #777; }
        .rowbtn { border: 1px solid #ccc; background: #fff; width: 20px; height: 20px; line-height: 1; border-radius: 3px; cursor: pointer; color: #a33; font-size: 13px; }
        .rowbtn.addbtn { color: #185a35; border-color: #217346; width: auto; padding: 3px 10px; font-size: 11.5px; }
        .history { background: #fff; border: 1px solid #b7b7b7; padding: 14px; }
        .stat-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 18px; }
        .stat-card { background: #f5f7f5; border: 1px solid #dde3de; border-radius: 6px; padding: 10px 12px; }
        .stat-label { font-size: 11px; color: #666; margin-bottom: 4px; }
        .stat-value { font-size: 18px; font-weight: 700; color: #1a1a1a; }
        .stat-value.pos { color: #0f7a3d; }
        .stat-value.neg { color: #c0221f; }
        .hist-heading { font-size: 13px; font-weight: 700; color: #217346; margin: 18px 0 8px; }
        .hist-heading-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 18px 0 8px; flex-wrap: wrap; }
        .hist-heading-row .hist-heading { margin: 0; }
        .chart-box { background: #fff; }
        .hist-table { min-width: 420px; }
        .empty-state { padding: 30px; text-align: center; color: #777; background: #fff; border: 1px solid #b7b7b7; }
        .goal-note { font-size: 11.5px; color: #666; margin-bottom: 8px; background: #f5f7f5; border: 1px solid #dde3de; padding: 6px 10px; border-radius: 4px; }
        .progress-track { position: relative; background: #eee; border-radius: 8px; height: 16px; width: 100%; min-width: 90px; overflow: hidden; }
        .progress-fill { background: #217346; height: 100%; }
        .progress-label { position: absolute; top: 0; left: 6px; font-size: 10px; line-height: 16px; color: #1a1a1a; font-weight: 700; }
        @media (max-width: 640px) {
          table.sheet { font-size: 11.5px; }
          .letter-row .letter { min-width: 76px; }
          .topbar h1 { font-size: 13px; }
        }
      `}</style>

      <div className="topbar">
        <h1>Financial Planner</h1>
        <div className="tabs-row">
          {TABS.map(t => (
            <button key={t.id} className={"tabbtn" + (view === t.id ? " active" : "")} onClick={() => setView(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="month-controls">
          <select className="monthselect" value={currentKey} onChange={e => switchMonth(e.target.value)}>
            {monthsIndex.map(k => <option key={k} value={k}>{monthLabel(k)}</option>)}
          </select>
          <button className="newmonthbtn" onClick={addNextMonth}>+ Next month</button>
          <span className="savebadge">{saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : ""}</span>
          <button className="signoutbtn" onClick={() => signOut(auth)}>Sign out</button>
        </div>
      </div>

      {view === "expenses" && <ExpensesTab month={month} setMonth={setMonth} />}
      {view === "savings" && <SavingsTab month={month} setMonth={setMonth} />}
      {view === "debt" && <DebtTab month={month} setMonth={setMonth} />}
      {view === "investments" && <InvestmentsTab month={month} setMonth={setMonth} />}
      {view === "goals" && (
        <GoalsTab goals={goals} setGoals={setGoals} avgSavings={avgSavings} monthsCounted={last3.length} />
      )}
      {view === "history" && <HistoryTab allMonths={allMonths} />}
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
