import React, { useState, useMemo } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  ComposedChart, Line, ReferenceLine,
} from "recharts";

// ─── Design System (matches BioCO₂) ───
const COLORS = {
  bg: "#0b1121", panel: "#0f172a", card: "#131d32", cardBorder: "#1e293b",
  panelBorder: "#1a2540", accent: "#22c55e", accentDim: "#16a34a",
  white: "#f1f5f9", textMuted: "#94a3b8", textDim: "#64748b",
  red: "#ef4444", amber: "#f59e0b", cyan: "#06b6d4",
};

const CHART_COLORS = {
  power: "#22c55e", thermal: "#f59e0b", tipping: "#06b6d4", carbon: "#a78bfa",
  revenue: "#22c55e", opex: "#ef4444", capex: "#f59e0b", debt: "#f97316",
};

const SCENARIOS = {
  conservative: { R_power: 0.08, R_therm: 0.022, R_tipping: 50, P_carbon: 10, f_avail: 0.85, C_biochp: 750000, N_units: 1, f_equity: 0.60, r_disc: 10 },
  base: { R_power: 0.10, R_therm: 0.027, R_tipping: 80, P_carbon: 20, f_avail: 0.92, C_biochp: 660000, N_units: 3, f_equity: 0.50, r_disc: 7 },
  optimistic: { R_power: 0.12, R_therm: 0.034, R_tipping: 100, P_carbon: 40, f_avail: 0.95, C_biochp: 550000, N_units: 10, f_equity: 0.40, r_disc: 5 },
};

// ─── Financial Model Engine ───
function runFinancialModel(inputs) {
  const {
    P_elec, P_therm, f_avail, F_tpd, N_units,
    R_power, f_power_util, r_power,
    R_therm, f_therm_util, r_therm,
    R_tipping, W_tpy, r_tipping,
    CC_methane, CC_fuel, CC_emissions, P_carbon, r_carbon,
    C_cust_power, C_cust_therm, C_cust_waste,
    C_biochp, C_enexfuel, C_install, C_site,
    R_maint, C_fuel_process, C_insurance, C_acct_mgmt, r_maint, r_fuel,
    f_equity, r_debt, T_loan, f_loan_fees,
    r_disc, T_project, Y_start, LR, units_per_year,
  } = inputs;

  const warnings = [];
  const hours_yr = 8760 * f_avail;
  const E_power_yr = P_elec * hours_yr;
  const E_therm_yr = P_therm * hours_yr;
  const F_tpy = F_tpd * 365 * f_avail;
  const CC_net = Math.max(0, CC_methane + CC_fuel - CC_emissions);

  // Customer savings (per unit, year 1)
  const C_current_power = E_power_yr * f_power_util * C_cust_power;
  const C_current_therm = E_therm_yr * f_therm_util * C_cust_therm;
  const C_current_waste = Math.min(F_tpy, W_tpy) * C_cust_waste;
  const C_current_total = C_current_power + C_current_therm + C_current_waste;

  const C_enexor_power = E_power_yr * f_power_util * R_power;
  const C_enexor_therm = E_therm_yr * f_therm_util * R_therm;
  const C_enexor_waste = Math.min(F_tpy, W_tpy) * R_tipping;
  const C_enexor_total = C_enexor_power + C_enexor_therm + C_enexor_waste;

  const savings_annual = C_current_total - C_enexor_total;
  const savings_pct = C_current_total > 0 ? (savings_annual / C_current_total) * 100 : 0;

  // CAPEX
  const CAPEX_unit1 = C_biochp + C_enexfuel + C_install;
  const lr_exp = Math.log(LR) / Math.log(2);
  const unit_capex = [];
  for (let n = 1; n <= N_units; n++) {
    unit_capex.push(CAPEX_unit1 * Math.pow(n, lr_exp));
  }
  const capex_fleet_total = unit_capex.reduce((s, v) => s + v, 0);

  // Debt service
  const CAPEX_debt = capex_fleet_total * (1 - f_equity);
  const loan_amount = CAPEX_debt * (1 + f_loan_fees / 100);
  let annual_debt_service = 0;
  if (CAPEX_debt > 0 && T_loan > 0 && r_debt > 0) {
    const r_monthly = r_debt / 100 / 12;
    const n_months = T_loan * 12;
    const monthly_payment = loan_amount * r_monthly / (1 - Math.pow(1 + r_monthly, -n_months));
    annual_debt_service = monthly_payment * 12;
  } else if (CAPEX_debt > 0 && T_loan > 0) {
    annual_debt_service = loan_amount / T_loan;
  }

  // Year-by-year
  const years = [];
  let cumulative_dcf = 0;
  let cumulative_cf = 0;
  let payback_disc = null;
  let payback_simple = null;

  for (let y = 0; y <= T_project; y++) {
    const year = Y_start + y;
    const N_deployed = Math.min(N_units, Math.floor(y * units_per_year) + 1);
    const N_prev = y === 0 ? 0 : Math.min(N_units, Math.floor((y - 1) * units_per_year) + 1);

    // CAPEX this year
    let capex_year = 0;
    for (let n = N_prev + 1; n <= N_deployed; n++) {
      capex_year += unit_capex[n - 1] || 0;
    }

    // Revenue
    const esc_power = Math.pow(1 + r_power / 100, y);
    const esc_therm = Math.pow(1 + r_therm / 100, y);
    const esc_tip = Math.pow(1 + r_tipping / 100, y);
    const esc_carbon = Math.pow(1 + r_carbon / 100, y);

    const R_pwr = N_deployed * E_power_yr * f_power_util * R_power * esc_power;
    const R_thrm = N_deployed * E_therm_yr * f_therm_util * R_therm * esc_therm;
    const W_tipped = Math.min(N_deployed * F_tpy, W_tpy);
    const R_tip = W_tipped * R_tipping * esc_tip;
    const R_crb = N_deployed * CC_net * P_carbon * esc_carbon;
    const R_total = R_pwr + R_thrm + R_tip + R_crb;

    // OPEX
    const esc_maint = Math.pow(1 + r_maint / 100, y);
    const esc_fuel = Math.pow(1 + r_fuel / 100, y);
    const esc_fixed = Math.pow(1.03, y);

    const C_maint = N_deployed * E_power_yr * R_maint * esc_maint;
    const C_fuel = N_deployed * F_tpy * C_fuel_process * esc_fuel;
    const C_fixed = N_deployed * (C_insurance + C_acct_mgmt) * esc_fixed;
    const OPEX = C_maint + C_fuel + C_fixed;

    const EBITDA = R_total - OPEX;
    const DS = y < T_loan ? annual_debt_service : 0;
    const DSCR = DS > 0 ? EBITDA / DS : null;
    const CF = R_total - OPEX - capex_year - DS;

    const discount_factor = Math.pow(1 + r_disc / 100, y);
    const DCF = CF / discount_factor;
    cumulative_dcf += DCF;
    cumulative_cf += CF;

    if (payback_disc === null && y > 0 && cumulative_dcf >= 0) payback_disc = y;
    if (payback_simple === null && y > 0 && cumulative_cf >= 0) payback_simple = y;

    years.push({
      y, year, N_deployed, R_pwr, R_thrm, R_tip, R_crb, R_total,
      OPEX, EBITDA, DS, DSCR, capex_year, CF, DCF, cumNPV: cumulative_dcf,
    });
  }

  // NPV
  const NPV = cumulative_dcf;

  // IRR
  let IRR = null;
  let lo = -0.5, hi = 2.0;
  for (let iter = 0; iter < 100; iter++) {
    const mid = (lo + hi) / 2;
    let npv_test = 0;
    for (const yr of years) {
      npv_test += yr.CF / Math.pow(1 + mid, yr.y);
    }
    if (npv_test > 0) lo = mid; else hi = mid;
    if (Math.abs(hi - lo) < 0.0001) break;
  }
  if (Math.abs(lo - (-0.5)) > 0.01 && Math.abs(hi - 2.0) > 0.01) {
    IRR = (lo + hi) / 2;
  }

  // DSCR minimum
  const dscr_values = years.filter(y => y.DSCR !== null).map(y => y.DSCR);
  const DSCR_min = dscr_values.length > 0 ? Math.min(...dscr_values) : null;

  // Revenue per unit (year 1)
  const yr1 = years[1] || years[0];
  const R_per_unit = yr1.N_deployed > 0 ? yr1.R_total / yr1.N_deployed : 0;

  // Revenue per unit breakdown
  const R_per_unit_power = yr1.N_deployed > 0 ? yr1.R_pwr / yr1.N_deployed : 0;
  const R_per_unit_therm = yr1.N_deployed > 0 ? yr1.R_thrm / yr1.N_deployed : 0;
  const R_per_unit_tip = yr1.N_deployed > 0 ? yr1.R_tip / yr1.N_deployed : 0;
  const R_per_unit_carbon = yr1.N_deployed > 0 ? yr1.R_crb / yr1.N_deployed : 0;

  // Warnings
  if (NPV < 0) warnings.push(`Project NPV is negative at ${r_disc}% discount rate.`);
  if (DSCR_min !== null && DSCR_min < 1.0) warnings.push(`⚠ DSCR falls below 1.0× — loan default risk. Increase equity or reduce debt.`);
  if (DSCR_min !== null && DSCR_min < 1.25 && DSCR_min >= 1.0) warnings.push(`⚠ DSCR below 1.25× — may not meet lender covenants.`);

  return {
    hours_yr, E_power_yr, E_therm_yr, F_tpy, CC_net,
    C_current_total, C_enexor_total, savings_annual, savings_pct,
    C_current_power, C_current_therm, C_current_waste,
    C_enexor_power, C_enexor_therm, C_enexor_waste,
    CAPEX_unit1, capex_fleet_total, unit_capex,
    loan_amount, annual_debt_service,
    NPV, IRR, payback_disc, payback_simple, DSCR_min,
    R_per_unit, R_per_unit_power, R_per_unit_therm, R_per_unit_tip, R_per_unit_carbon,
    years, warnings,
    yr1_revenue: yr1.R_total, yr1_opex: yr1.OPEX, yr1_ebitda: yr1.EBITDA,
  };
}

// Sensitivity
function runSensitivity(baseInputs) {
  const baseNPV = runFinancialModel(baseInputs).NPV;
  const params = [
    { key: "R_power", label: "Power Rate" },
    { key: "R_therm", label: "Thermal Rate" },
    { key: "R_tipping", label: "Tipping Fee" },
    { key: "P_carbon", label: "Carbon Price" },
    { key: "f_avail", label: "Availability" },
    { key: "C_biochp", label: "BioCHP Cost" },
    { key: "C_fuel_process", label: "Fuel Process Cost" },
    { key: "r_disc", label: "Discount Rate" },
  ];
  return params.map(p => {
    const lo = { ...baseInputs, [p.key]: baseInputs[p.key] * 0.8 };
    const hi = { ...baseInputs, [p.key]: baseInputs[p.key] * 1.2 };
    const npvLo = runFinancialModel(lo).NPV;
    const npvHi = runFinancialModel(hi).NPV;
    return { label: p.label, lo: npvLo - baseNPV, hi: npvHi - baseNPV, range: Math.abs(npvHi - npvLo) };
  }).sort((a, b) => b.range - a.range);
}

// ─── Formatters ───
const fmt$ = (v) => {
  if (v == null || isNaN(v)) return "—";
  const abs = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
};
const fmtPct = (v) => v != null ? `${v.toFixed(1)}%` : "—";

// ─── UI Components ───
function SliderInput({ label, value, onChange, min, max, step, unit = "", decimals = 2, prefix = "" }) {
  const [editing, setEditing] = useState(false);
  const [editVal, setEditVal] = useState("");
  const pct = ((value - min) / (max - min)) * 100;

  const startEdit = () => { setEditing(true); setEditVal(String(value)); };
  const commitEdit = () => {
    setEditing(false);
    const n = parseFloat(editVal);
    if (!isNaN(n)) onChange(Math.min(max, Math.max(min, n)));
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: COLORS.textMuted }}>{label}</span>
        {editing ? (
          <input autoFocus value={editVal} onChange={e => setEditVal(e.target.value)}
            onBlur={commitEdit} onKeyDown={e => e.key === "Enter" && commitEdit()}
            style={{ width: 70, background: COLORS.bg, border: `1px solid ${COLORS.accent}`, borderRadius: 3,
              color: COLORS.white, textAlign: "right", fontSize: 12, padding: "1px 4px",
              fontFamily: "'JetBrains Mono', monospace" }} />
        ) : (
          <span onClick={startEdit} style={{ fontSize: 12, color: COLORS.white, cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace", borderBottom: `1px dashed ${COLORS.textDim}` }}>
            {prefix}{value.toFixed(decimals)} <span style={{ color: COLORS.textDim, fontSize: 10 }}>{unit}</span>
          </span>
        )}
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", height: 4, appearance: "none", background:
          `linear-gradient(to right, ${COLORS.accent} 0%, ${COLORS.accent} ${pct}%, ${COLORS.panelBorder} ${pct}%, ${COLORS.panelBorder} 100%)`,
          borderRadius: 2, outline: "none", cursor: "pointer" }} />
    </div>
  );
}

function MetricCard({ label, value, unit = "", prefix = "", status, decimals, tip }) {
  const color = status === "ok" ? COLORS.accent : status === "warn" ? COLORS.amber : status === "error" ? COLORS.red : COLORS.white;
  let display;
  if (value == null || (typeof value === "number" && (isNaN(value) || !isFinite(value)))) {
    display = "—";
  } else if (typeof value === "string") {
    display = value;
  } else if (prefix === "$") {
    display = fmt$(value);
  } else {
    const d = decimals !== undefined ? decimals : (Math.abs(value) >= 100 ? 0 : 1);
    display = `${prefix}${value.toFixed(d)}`;
  }
  return (
    <div title={tip} style={{ background: COLORS.card, borderRadius: 6, border: `1px solid ${COLORS.cardBorder}`,
      padding: "8px 10px", textAlign: "center" }}>
      <div style={{ fontSize: 9, color: COLORS.textDim, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>
        {label} {tip && <span style={{ cursor: "help", opacity: 0.5 }}>ⓘ</span>}
      </div>
      <div style={{ fontSize: 20, fontWeight: 700, color, fontFamily: "'JetBrains Mono', monospace" }}>{display}</div>
      {unit && <div style={{ fontSize: 9, color: COLORS.textDim, marginTop: 2 }}>{unit}</div>}
    </div>
  );
}

function Accordion({ title, icon, children, defaultOpen }) {
  const [open, setOpen] = useState(defaultOpen || false);
  return (
    <div style={{ marginBottom: 6 }}>
      <div onClick={() => setOpen(!open)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "6px 8px", background: COLORS.card, borderRadius: 4, cursor: "pointer", border: `1px solid ${COLORS.cardBorder}` }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: COLORS.accent, textTransform: "uppercase", letterSpacing: "0.04em" }}>
          {icon} {title}
        </span>
        <span style={{ color: COLORS.textDim, fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </div>
      {open && <div style={{ padding: "8px 6px 2px" }}>{children}</div>}
    </div>
  );
}

function DiagnosticHint({ text, color = "amber" }) {
  const bg = color === "red" ? "rgba(239,68,68,0.12)" : "rgba(245,158,11,0.12)";
  const border = color === "red" ? COLORS.red : COLORS.amber;
  const textColor = color === "red" ? COLORS.red : COLORS.amber;
  return (
    <div style={{ background: bg, border: `1px solid ${border}33`, borderRadius: 4, padding: "6px 10px",
      fontSize: 11, color: textColor, marginBottom: 6 }}>{text}</div>
  );
}

// ─── Tooltip ───
const customTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.cardBorder}`, borderRadius: 6, padding: "8px 12px", fontSize: 11 }}>
      <div style={{ color: COLORS.white, fontWeight: 600, marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || COLORS.textMuted, display: "flex", justifyContent: "space-between", gap: 16 }}>
          <span>{p.name}</span>
          <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

// ─── Main App ───
export default function BioCHPFinancialApp() {
  const [scenario, setScenario] = useState("base");
  const [inputs, setInputs] = useState({
    P_elec: 225, P_therm: 400, f_avail: 0.92, F_tpd: 5, N_units: 3,
    R_power: 0.10, f_power_util: 1.0, r_power: 3.0,
    R_therm: 0.027, f_therm_util: 1.0, r_therm: 3.0,
    R_tipping: 80, W_tpy: 3000, r_tipping: 3.0,
    CC_methane: 1200, CC_fuel: 1100, CC_emissions: 500, P_carbon: 20, r_carbon: 3.0,
    C_cust_power: 0.143, C_cust_therm: 0.034, C_cust_waste: 100,
    C_biochp: 660000, C_enexfuel: 45000, C_install: 25000, C_site: 12500,
    R_maint: 0.025, C_fuel_process: 70, C_insurance: 2000, C_acct_mgmt: 2920,
    r_maint: 3.0, r_fuel: 3.0,
    f_equity: 0.50, r_debt: 6.0, T_loan: 5, f_loan_fees: 2.0,
    r_disc: 7.0, T_project: 10, Y_start: 2026, LR: 0.90, units_per_year: 2,
  });

  const applyScenario = (key) => {
    setScenario(key);
    if (SCENARIOS[key]) setInputs(prev => ({ ...prev, ...SCENARIOS[key] }));
  };

  const set = (key) => (val) => {
    setScenario("custom");
    setInputs(prev => ({ ...prev, [key]: val }));
  };

  const results = useMemo(() => runFinancialModel(inputs), [inputs]);
  const sensitivity = useMemo(() => runSensitivity(inputs), [inputs]);

  const yr1 = results.years[1] || results.years[0];

  // Chart data
  const revenueData = [
    { name: "Power", value: yr1?.R_pwr || 0, fill: CHART_COLORS.power },
    { name: "Thermal", value: yr1?.R_thrm || 0, fill: CHART_COLORS.thermal },
    { name: "Tipping", value: yr1?.R_tip || 0, fill: CHART_COLORS.tipping },
    { name: "Carbon", value: yr1?.R_crb || 0, fill: CHART_COLORS.carbon },
  ].filter(d => d.value > 0);

  const cashFlowData = results.years.map(yr => ({
    name: yr.year, Revenue: yr.R_total, OPEX: -yr.OPEX,
    CAPEX: yr.capex_year > 0 ? -yr.capex_year : 0,
    Debt: yr.DS > 0 ? -yr.DS : 0,
    CumNPV: yr.cumNPV,
  }));

  const fleetData = results.unit_capex.map((c, i) => ({ unit: `#${i + 1}`, cost: c }));

  return (
    <div style={{ background: COLORS.bg, minHeight: "100vh", color: COLORS.white, fontFamily: "'DM Sans', sans-serif" }}>

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 20px", borderBottom: `1px solid ${COLORS.panelBorder}`, background: COLORS.panel }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <svg width={32} height={32} viewBox="0 0 600 600" fill="none">
            <path d="M21.6,63.5h100.4c21.4,0,41.9,9,56.4,24.8l179.1,200.7-139.5,152.2c-14.5,15.8-35,24.9-56.5,24.9H60.2s162.8-177,162.8-177L21.6,63.5Z" fill="#fff"/>
            <path d="M375.2,269.6l145.1-158.3h-100.4c-21.4,0-41.9,9-56.4,24.8l-55,59.8,66.8,73.7Z" fill="#fff"/>
            <path d="M374.5,309.9l-67.7,73.9,113.7,127.9c14.5,15.8,35,24.9,56.5,24.9h101.4l-203.8-226.6Z" fill="#fff"/>
          </svg>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>BioCHP Financial Analysis</div>
            <div style={{ fontSize: 10, color: COLORS.textDim }}>ENEXOR BIOENERGY · MCS v1.0 · ENERGY-AS-A-SERVICE</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {["conservative", "base", "optimistic", "custom"].map(s => (
            <button key={s} onClick={() => applyScenario(s)}
              style={{ padding: "5px 14px", borderRadius: 4, border: `1px solid ${scenario === s ? COLORS.accent : COLORS.panelBorder}`,
                background: scenario === s ? COLORS.accent : "transparent",
                color: scenario === s ? COLORS.bg : COLORS.textMuted,
                fontSize: 11, fontWeight: 600, cursor: "pointer", textTransform: "uppercase" }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Three Column Layout */}
      <div style={{ display: "flex", height: "calc(100vh - 56px)" }}>

        {/* LEFT: Inputs */}
        <div style={{ width: 320, minWidth: 320, overflowY: "auto", maxHeight: "calc(100vh - 56px)",
          borderRight: `1px solid ${COLORS.panelBorder}`, padding: "12px 10px", background: COLORS.panel }}>

          <Accordion title="System Performance" icon="⚡" defaultOpen={true}>
            <SliderInput label="Electrical Output" value={inputs.P_elec} onChange={set("P_elec")} min={50} max={500} step={25} unit="kW" decimals={0} />
            <SliderInput label="Thermal Output" value={inputs.P_therm} onChange={set("P_therm")} min={100} max={1000} step={25} unit="kWth" decimals={0} />
            <SliderInput label="Availability" value={inputs.f_avail} onChange={set("f_avail")} min={0.70} max={0.99} step={0.01} unit="" decimals={2} />
            <SliderInput label="Feedstock Required" value={inputs.F_tpd} onChange={set("F_tpd")} min={1} max={20} step={0.5} unit="t/day" decimals={1} />
          </Accordion>

          <Accordion title="Power Revenue" icon="⊕">
            <SliderInput label="Power Rate" value={inputs.R_power} onChange={set("R_power")} min={0.04} max={0.25} step={0.005} unit="$/kWh" decimals={3} prefix="$" />
            <SliderInput label="Power Utilization" value={inputs.f_power_util} onChange={set("f_power_util")} min={0} max={1} step={0.05} unit="" decimals={2} />
            <SliderInput label="Power Escalation" value={inputs.r_power} onChange={set("r_power")} min={0} max={8} step={0.5} unit="%/yr" decimals={1} />
          </Accordion>

          <Accordion title="Thermal Revenue" icon="◎">
            <SliderInput label="Thermal Rate" value={inputs.R_therm} onChange={set("R_therm")} min={0.01} max={0.10} step={0.001} unit="$/kWh" decimals={3} prefix="$" />
            <SliderInput label="Thermal Utilization" value={inputs.f_therm_util} onChange={set("f_therm_util")} min={0} max={1} step={0.05} unit="" decimals={2} />
            <SliderInput label="Thermal Escalation" value={inputs.r_therm} onChange={set("r_therm")} min={0} max={8} step={0.5} unit="%/yr" decimals={1} />
          </Accordion>

          <Accordion title="Waste Processing" icon="♻">
            <SliderInput label="Tipping Fee" value={inputs.R_tipping} onChange={set("R_tipping")} min={0} max={200} step={5} unit="$/ton" decimals={0} prefix="$" />
            <SliderInput label="Waste Available" value={inputs.W_tpy} onChange={set("W_tpy")} min={0} max={10000} step={100} unit="t/yr" decimals={0} />
            <SliderInput label="Tipping Escalation" value={inputs.r_tipping} onChange={set("r_tipping")} min={0} max={8} step={0.5} unit="%/yr" decimals={1} />
          </Accordion>

          <Accordion title="Carbon Credits" icon="◆">
            <SliderInput label="Methane Offsets" value={inputs.CC_methane} onChange={set("CC_methane")} min={0} max={5000} step={100} unit="MTCO₂e/yr" decimals={0} />
            <SliderInput label="Fuel Offsets" value={inputs.CC_fuel} onChange={set("CC_fuel")} min={0} max={5000} step={100} unit="MTCO₂e/yr" decimals={0} />
            <SliderInput label="Project Emissions" value={inputs.CC_emissions} onChange={set("CC_emissions")} min={0} max={3000} step={50} unit="MTCO₂e/yr" decimals={0} />
            <SliderInput label="Carbon Price" value={inputs.P_carbon} onChange={set("P_carbon")} min={0} max={100} step={1} unit="$/ton" decimals={0} prefix="$" />
            <SliderInput label="Carbon Escalation" value={inputs.r_carbon} onChange={set("r_carbon")} min={0} max={8} step={0.5} unit="%/yr" decimals={1} />
          </Accordion>

          <Accordion title="Customer Current Costs" icon="⇄">
            <SliderInput label="Current Power Rate" value={inputs.C_cust_power} onChange={set("C_cust_power")} min={0.05} max={0.40} step={0.005} unit="$/kWh" decimals={3} prefix="$" />
            <SliderInput label="Current Thermal Rate" value={inputs.C_cust_therm} onChange={set("C_cust_therm")} min={0.01} max={0.15} step={0.001} unit="$/kWh" decimals={3} prefix="$" />
            <SliderInput label="Current Waste Cost" value={inputs.C_cust_waste} onChange={set("C_cust_waste")} min={0} max={300} step={5} unit="$/ton" decimals={0} prefix="$" />
          </Accordion>

          <Accordion title="CAPEX — Equipment" icon="⚙">
            <SliderInput label="BioCHP System" value={inputs.C_biochp} onChange={set("C_biochp")} min={200000} max={1500000} step={10000} unit="" decimals={0} prefix="$" />
            <SliderInput label="EnexFuel Equipment" value={inputs.C_enexfuel} onChange={set("C_enexfuel")} min={10000} max={150000} step={5000} unit="" decimals={0} prefix="$" />
            <SliderInput label="Shipping & Install" value={inputs.C_install} onChange={set("C_install")} min={10000} max={80000} step={5000} unit="" decimals={0} prefix="$" />
          </Accordion>

          <Accordion title="OPEX" icon="⟳">
            <SliderInput label="Maintenance Rate" value={inputs.R_maint} onChange={set("R_maint")} min={0.01} max={0.06} step={0.005} unit="$/kWh" decimals={3} prefix="$" />
            <SliderInput label="EnexFuel Processing" value={inputs.C_fuel_process} onChange={set("C_fuel_process")} min={20} max={150} step={5} unit="$/ton" decimals={0} prefix="$" />
            <SliderInput label="Insurance" value={inputs.C_insurance} onChange={set("C_insurance")} min={500} max={10000} step={250} unit="/yr" decimals={0} prefix="$" />
            <SliderInput label="Account Management" value={inputs.C_acct_mgmt} onChange={set("C_acct_mgmt")} min={1000} max={10000} step={250} unit="/yr" decimals={0} prefix="$" />
          </Accordion>

          <Accordion title="Financing" icon="◈">
            <SliderInput label="Equity %" value={inputs.f_equity} onChange={set("f_equity")} min={0} max={1} step={0.05} unit="" decimals={2} />
            <SliderInput label="Debt Rate" value={inputs.r_debt} onChange={set("r_debt")} min={2} max={15} step={0.5} unit="%" decimals={1} />
            <SliderInput label="Loan Term" value={inputs.T_loan} onChange={set("T_loan")} min={1} max={15} step={1} unit="yrs" decimals={0} />
            <SliderInput label="Loan Fees" value={inputs.f_loan_fees} onChange={set("f_loan_fees")} min={0} max={5} step={0.5} unit="%" decimals={1} />
            <SliderInput label="Discount Rate" value={inputs.r_disc} onChange={set("r_disc")} min={4} max={20} step={0.5} unit="%" decimals={1} />
          </Accordion>

          <Accordion title="Fleet & Project" icon="▥">
            <SliderInput label="Number of Units" value={inputs.N_units} onChange={set("N_units")} min={1} max={50} step={1} unit="units" decimals={0} />
            <SliderInput label="Contract Term" value={inputs.T_project} onChange={set("T_project")} min={5} max={25} step={1} unit="yrs" decimals={0} />
            <SliderInput label="Learning Rate" value={inputs.LR} onChange={set("LR")} min={0.75} max={0.95} step={0.01} unit="" decimals={2} />
            <SliderInput label="Deploy Rate" value={inputs.units_per_year} onChange={set("units_per_year")} min={1} max={10} step={1} unit="/yr" decimals={0} />
          </Accordion>
        </div>

        {/* CENTER: Charts & Metrics */}
        <div style={{ flex: 1, overflowY: "auto", maxHeight: "calc(100vh - 56px)", padding: "16px 20px" }}>

          {/* Metric Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 16 }}>
            <MetricCard label="NPV" value={results.NPV} prefix="$"
              status={results.NPV > 0 ? "ok" : "error"}
              tip="Net Present Value — sum of all discounted cash flows. Positive = project creates value above hurdle rate." />
            <MetricCard label="IRR" value={results.IRR !== null ? results.IRR * 100 : null} unit="%"
              status={results.IRR !== null ? (results.IRR * 100 > inputs.r_disc ? "ok" : results.IRR > 0 ? "warn" : "error") : undefined}
              tip="Internal Rate of Return — annualized equity return. Green when above discount rate." />
            <MetricCard label="Payback" value={results.payback_disc || "> " + inputs.T_project} unit={results.payback_disc ? "yrs" : ""}
              status={results.payback_disc ? (results.payback_disc < 4 ? "ok" : results.payback_disc < 7 ? "warn" : "error") : "error"}
              tip="Discounted Payback — years until cumulative discounted cash flow turns positive." />
            <MetricCard label="Rev/Unit" value={results.R_per_unit} prefix="$" unit="/yr"
              tip="Year 1 total revenue per active BioCHP unit across all four streams." />
            <MetricCard label="DSCR" value={results.DSCR_min} unit="×" decimals={2}
              status={results.DSCR_min !== null ? (results.DSCR_min >= 1.25 ? "ok" : results.DSCR_min >= 1.0 ? "warn" : "error") : undefined}
              tip="Debt Service Coverage Ratio — EBITDA ÷ annual debt payment. Lenders require ≥ 1.25×." />
            <MetricCard label="Cust. Savings" value={results.savings_pct} unit="%" decimals={1}
              status={results.savings_pct > 15 ? "ok" : results.savings_pct > 0 ? "warn" : "error"}
              tip="Customer cost reduction vs current power + thermal + waste disposal costs." />
          </div>

          {/* Diagnostics */}
          {results.warnings.map((w, i) => <DiagnosticHint key={i} text={w} color={w.includes("negative") || w.includes("default risk") ? "red" : "amber"} />)}

          {/* Revenue Waterfall */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
              Revenue Breakdown — Year 1 ({fmt$(yr1?.R_total || 0)} total)
            </div>
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={revenueData} layout="vertical" margin={{ left: 60, right: 20 }}>
                <XAxis type="number" tickFormatter={fmt$} tick={{ fill: COLORS.textDim, fontSize: 10 }} />
                <YAxis type="category" dataKey="name" tick={{ fill: COLORS.textDim, fontSize: 11 }} width={50} />
                <Tooltip content={customTooltip} />
                <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                  {revenueData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Cash Flow */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
              Cash Flow & Cumulative NPV
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <ComposedChart data={cashFlowData} margin={{ left: 10, right: 10 }}>
                <XAxis dataKey="name" tick={{ fill: COLORS.textDim, fontSize: 9 }} />
                <YAxis yAxisId="left" tickFormatter={fmt$} tick={{ fill: COLORS.textDim, fontSize: 9 }} />
                <YAxis yAxisId="right" orientation="right" tickFormatter={fmt$} tick={{ fill: COLORS.textDim, fontSize: 9 }} />
                <Tooltip content={customTooltip} />
                <ReferenceLine yAxisId="left" y={0} stroke={COLORS.panelBorder} />
                <Bar yAxisId="left" dataKey="Revenue" fill={CHART_COLORS.revenue} opacity={0.7} stackId="a" />
                <Bar yAxisId="left" dataKey="OPEX" fill={CHART_COLORS.opex} opacity={0.7} stackId="a" />
                <Bar yAxisId="left" dataKey="CAPEX" fill={CHART_COLORS.capex} opacity={0.7} stackId="a" />
                <Bar yAxisId="left" dataKey="Debt" fill={CHART_COLORS.debt} opacity={0.5} stackId="a" />
                <Line yAxisId="right" dataKey="CumNPV" type="monotone" stroke={COLORS.white} strokeWidth={2} dot={{ r: 2, fill: COLORS.white }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Sensitivity */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
              Sensitivity — NPV Impact (±20%)
            </div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={sensitivity} layout="vertical" margin={{ left: 100, right: 20 }}>
                <XAxis type="number" tickFormatter={fmt$} tick={{ fill: COLORS.textDim, fontSize: 9 }} />
                <YAxis type="category" dataKey="label" tick={{ fill: COLORS.textMuted, fontSize: 10 }} width={90} />
                <Tooltip content={customTooltip} />
                <ReferenceLine x={0} stroke={COLORS.panelBorder} />
                <Bar dataKey="lo" fill={COLORS.red} opacity={0.7} name="−20%" />
                <Bar dataKey="hi" fill={COLORS.accent} opacity={0.7} name="+20%" />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Fleet Learning Curve */}
          {inputs.N_units > 1 && (
            <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 16, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
                Fleet CAPEX — Learning Curve ({(inputs.LR * 100).toFixed(0)}% rate)
              </div>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={fleetData} margin={{ left: 10, right: 10 }}>
                  <XAxis dataKey="unit" tick={{ fill: COLORS.textDim, fontSize: 9 }} />
                  <YAxis tickFormatter={fmt$} tick={{ fill: COLORS.textDim, fontSize: 9 }} />
                  <Tooltip content={customTooltip} />
                  <Bar dataKey="cost" name="Unit CAPEX" radius={[3, 3, 0, 0]}>
                    {fleetData.map((_, i) => <Cell key={i} fill={i === 0 ? COLORS.accent : COLORS.accentDim} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        {/* RIGHT: Summary & Table */}
        <div style={{ width: 320, minWidth: 320, overflowY: "auto", maxHeight: "calc(100vh - 56px)",
          borderLeft: `1px solid ${COLORS.panelBorder}`, padding: "12px 10px", background: COLORS.panel }}>

          {/* Customer Savings */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
              Customer Savings (per unit, Year 1)
            </div>
            <table style={{ width: "100%", fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${COLORS.panelBorder}` }}>
                  <th style={{ textAlign: "left", color: COLORS.textDim, fontWeight: 500, paddingBottom: 4 }}></th>
                  <th style={{ textAlign: "right", color: COLORS.textDim, fontWeight: 500, paddingBottom: 4 }}>Current</th>
                  <th style={{ textAlign: "right", color: COLORS.textDim, fontWeight: 500, paddingBottom: 4 }}>Enexor</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { label: "Power", current: results.C_current_power, enexor: results.C_enexor_power },
                  { label: "Thermal", current: results.C_current_therm, enexor: results.C_enexor_therm },
                  { label: "Waste", current: results.C_current_waste, enexor: results.C_enexor_waste },
                ].map((r, i) => (
                  <tr key={i}>
                    <td style={{ color: COLORS.textMuted, padding: "3px 0" }}>{r.label}</td>
                    <td style={{ textAlign: "right", color: COLORS.red, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(r.current)}</td>
                    <td style={{ textAlign: "right", color: COLORS.accent, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(r.enexor)}</td>
                  </tr>
                ))}
                <tr style={{ borderTop: `1px solid ${COLORS.panelBorder}` }}>
                  <td style={{ color: COLORS.white, fontWeight: 600, paddingTop: 4 }}>Total</td>
                  <td style={{ textAlign: "right", color: COLORS.red, fontWeight: 600, paddingTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(results.C_current_total)}</td>
                  <td style={{ textAlign: "right", color: COLORS.accent, fontWeight: 600, paddingTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(results.C_enexor_total)}</td>
                </tr>
              </tbody>
            </table>
            <div style={{ marginTop: 8, padding: "6px 8px", background: results.savings_pct > 0 ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
              borderRadius: 4, textAlign: "center" }}>
              <span style={{ fontSize: 16, fontWeight: 700, color: results.savings_pct > 0 ? COLORS.accent : COLORS.red,
                fontFamily: "'JetBrains Mono', monospace" }}>
                {results.savings_pct > 0 ? "↓" : "↑"} {Math.abs(results.savings_pct).toFixed(1)}%
              </span>
              <span style={{ fontSize: 11, color: COLORS.textMuted, marginLeft: 8 }}>
                {results.savings_pct > 0 ? "savings" : "premium"} ({fmt$(results.savings_annual)}/yr)
              </span>
            </div>
          </div>

          {/* CAPEX Summary */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>CAPEX Summary</div>
            {[
              { label: "Unit 1", value: results.CAPEX_unit1 },
              ...(inputs.N_units > 1 ? [{ label: `Unit ${inputs.N_units}`, value: results.unit_capex[inputs.N_units - 1] }] : []),
            ].map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                <span style={{ fontSize: 11, color: COLORS.textMuted }}>{r.label}</span>
                <span style={{ fontSize: 12, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(r.value)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${COLORS.panelBorder}`, paddingTop: 4, marginTop: 4 }}>
              <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600 }}>Fleet Total ({inputs.N_units})</span>
              <span style={{ fontSize: 12, color: COLORS.accent, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{fmt$(results.capex_fleet_total)}</span>
            </div>
          </div>

          {/* Debt Service */}
          {results.annual_debt_service > 0 && (
            <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
              <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>Debt Service</div>
              {[
                { label: "Loan Amount", value: fmt$(results.loan_amount) },
                { label: "Annual Payment", value: fmt$(results.annual_debt_service) },
                { label: "Loan Term", value: `${inputs.T_loan} yrs` },
                { label: "Equity Required", value: fmt$(results.capex_fleet_total * inputs.f_equity) },
              ].map((r, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                  <span style={{ fontSize: 11, color: COLORS.textMuted }}>{r.label}</span>
                  <span style={{ fontSize: 12, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>{r.value}</span>
                </div>
              ))}
            </div>
          )}

          {/* Revenue Per Unit */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>Revenue per Unit (Year 1)</div>
            {[
              { label: "Power", value: results.R_per_unit_power, color: CHART_COLORS.power },
              { label: "Thermal", value: results.R_per_unit_therm, color: CHART_COLORS.thermal },
              { label: "Tipping", value: results.R_per_unit_tip, color: CHART_COLORS.tipping },
              { label: "Carbon", value: results.R_per_unit_carbon, color: CHART_COLORS.carbon },
            ].filter(r => r.value > 0).map((r, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 6, height: 6, borderRadius: 2, background: r.color }} />
                  <span style={{ fontSize: 11, color: COLORS.textMuted }}>{r.label}</span>
                </div>
                <span style={{ fontSize: 12, color: COLORS.white, fontFamily: "'JetBrains Mono', monospace" }}>{fmt$(r.value)}</span>
              </div>
            ))}
            <div style={{ display: "flex", justifyContent: "space-between", borderTop: `1px solid ${COLORS.panelBorder}`, paddingTop: 4, marginTop: 4 }}>
              <span style={{ fontSize: 11, color: COLORS.accent, fontWeight: 600 }}>Total</span>
              <span style={{ fontSize: 12, color: COLORS.accent, fontFamily: "'JetBrains Mono', monospace", fontWeight: 700 }}>{fmt$(results.R_per_unit)}/yr</span>
            </div>
          </div>

          {/* Cash Flow Table */}
          <div style={{ background: COLORS.card, borderRadius: 8, border: `1px solid ${COLORS.cardBorder}`, padding: 12, marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: COLORS.textDim, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>Cash Flow Table</div>
            <div style={{ maxHeight: 300, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${COLORS.panelBorder}` }}>
                    {["Year", "Units", "Rev", "OPEX", "Cash Flow"].map(h => (
                      <th key={h} style={{ padding: "3px 4px", color: COLORS.textDim, fontWeight: 600, textAlign: "right", fontSize: 9 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results.years.map((yr, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${COLORS.bg}`, background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)" }}>
                      <td style={{ padding: "2px 4px", color: COLORS.textMuted, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>{yr.year}</td>
                      <td style={{ padding: "2px 4px", color: COLORS.textMuted, textAlign: "right" }}>{yr.N_deployed}</td>
                      <td style={{ padding: "2px 4px", color: COLORS.accent, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>
                        {yr.R_total >= 1000 ? `${(yr.R_total/1000).toFixed(0)}K` : yr.R_total.toFixed(0)}
                      </td>
                      <td style={{ padding: "2px 4px", color: COLORS.red, textAlign: "right", fontFamily: "'JetBrains Mono', monospace" }}>
                        {yr.OPEX >= 1000 ? `${(yr.OPEX/1000).toFixed(0)}K` : yr.OPEX.toFixed(0)}
                      </td>
                      <td style={{ padding: "2px 4px", color: yr.CF >= 0 ? COLORS.accent : COLORS.red, textAlign: "right", fontFamily: "'JetBrains Mono', monospace", fontWeight: 600 }}>
                        {yr.CF >= 0 ? "" : "-"}{Math.abs(yr.CF) >= 1000 ? `${(Math.abs(yr.CF)/1000).toFixed(0)}K` : Math.abs(yr.CF).toFixed(0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
