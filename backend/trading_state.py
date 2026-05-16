from pydantic import BaseModel, Field
from typing import Optional, Literal
from datetime import datetime


# ─── Enums / Literals ────────────────────────────────────────────────────────

Bias        = Literal["bullish", "bearish", "neutral"]
Side        = Literal["long", "short"]
Status      = Literal["watching", "in_trade", "stopped_out", "target_hit", "cancelled"]
Timeframe   = Literal["1m", "3m", "5m", "15m", "1h", "4h"]


# ─── Sub-models ───────────────────────────────────────────────────────────────

class FVG(BaseModel):
    """A Fair Value Gap zone."""
    timeframe: Timeframe
    high: float
    low: float
    direction: Bias            # bullish FVG or bearish FVG
    inversed: bool = False     # has it been inversed into an iFVG?
    previously_touched: bool = False
    swing_swept: bool = False  # swing H/L associated with this FVG swept?

    @property
    def midpoint(self) -> float:
        return round((self.high + self.low) / 2, 2)


class KeyLevels(BaseModel):
    """Price levels being tracked."""
    htf_fvg: Optional[FVG] = None          # 15m-1h FVG that price hit post open
    entry_ifvg: Optional[FVG] = None       # 1m-5m iFVG used for entry
    vwap: Optional[float] = None
    support: list[float] = Field(default_factory=list)
    resistance: list[float] = Field(default_factory=list)
    invalidation: Optional[float] = None   # level that kills the thesis


class SMTDivergence(BaseModel):
    """Smart Money Technique divergence observation."""
    present: bool = False
    description: str = ""  # e.g. 'ES new high, NQ failing'
    timeframe: Optional[Timeframe] = None


class ActiveTrade(BaseModel):
    """Tracks an open or recently closed trade."""
    symbol: str
    side: Side
    entry: float
    stop: float
    target: float
    size: int = 1              # number of contracts
    status: Status = "watching"
    entry_ifvg_tf: Optional[Timeframe] = None  # which iFVG timeframe triggered entry
    notes: str = ""

    @property
    def risk_pts(self) -> float:
        return round(abs(self.entry - self.stop), 2)

    @property
    def reward_pts(self) -> float:
        return round(abs(self.target - self.entry), 2)

    @property
    def rr(self) -> float:
        return round(self.reward_pts / self.risk_pts, 2) if self.risk_pts else 0


# ─── Master Session State ─────────────────────────────────────────────────────

class TradingSessionState(BaseModel):
    """Full state for one trading session."""

    # Identity
    symbol: str = "MNQ"                    # e.g. MNQ, MES
    session_date: str = Field(
        default_factory=lambda: datetime.now().strftime("%Y-%m-%d")
    )

    # Step 1 — Higher Timeframe Bias (1h + 4h)
    htf_bias: Bias = "neutral"
    htf_structure: str = ""               # e.g. 'HH/HL on 1h, LH/LL on 4h'
    htf_fvg_behavior: str = ""            # bullish FVGs respected, bearish disrespected?
    htf_smt: SMTDivergence = Field(default_factory=SMTDivergence)

    # Step 2 — Post-Open FVG Draw (15m-1h)
    market_open_done: bool = False         # 9:30am check
    htf_fvg_hit: bool = False             # price reached the draw FVG?
    key_levels: KeyLevels = Field(default_factory=KeyLevels)

    # Step 3 — Entry iFVG (1m-5m)
    entry_ifvg_identified: bool = False
    entry_smt: SMTDivergence = Field(default_factory=SMTDivergence)

    # Step 4 — Active trade
    active_trade: Optional[ActiveTrade] = None
    status: Status = "watching"

    # Session notes
    session_notes: list[str] = Field(default_factory=list)
    last_updated: str = Field(
        default_factory=lambda: datetime.now().strftime("%H:%M:%S")
    )

    def add_note(self, note: str):
        ts = datetime.now().strftime("%H:%M")
        self.session_notes.append(f"[{ts}] {note}")
        self.last_updated = datetime.now().strftime("%H:%M:%S")

    def checklist_summary(self) -> str:
        """Returns a quick Step 1-4 checklist string for Alpha to read."""
        lines = [
            f"Symbol: {self.symbol}",
            f"Step 1 - HTF Bias: {self.htf_bias.upper()} | Structure: {self.htf_structure or 'not set'}",
            f"         FVG behavior: {self.htf_fvg_behavior or 'not set'}",
            f"         SMT: {'YES - ' + self.htf_smt.description if self.htf_smt.present else 'none'}",
            f"Step 2 - Market open: {'done' if self.market_open_done else 'waiting'} | HTF FVG hit: {'YES' if self.htf_fvg_hit else 'NO'}",
        ]
        if self.key_levels.htf_fvg:
            fvg = self.key_levels.htf_fvg
            lines.append(
                f"         HTF FVG ({fvg.timeframe}): {fvg.low} - {fvg.high} | "
                f"Prev touched: {fvg.previously_touched} | Swing swept: {fvg.swing_swept}"
            )
        lines.append(f"Step 3 - Entry iFVG identified: {'YES' if self.entry_ifvg_identified else 'NO'}")
        if self.key_levels.entry_ifvg:
            ifvg = self.key_levels.entry_ifvg
            lines.append(f"         iFVG ({ifvg.timeframe}): {ifvg.low} - {ifvg.high}")
        lines.append(f"         Entry SMT: {'YES - ' + self.entry_smt.description if self.entry_smt.present else 'none'}")
        lines.append(f"Step 4 - Status: {self.status.upper()}")
        if self.active_trade:
            t = self.active_trade
            lines.append(
                f"         Trade: {t.side.upper()} {t.size}x @ {t.entry} | SL {t.stop} | TP {t.target} | R:R {t.rr}"
            )
        if self.session_notes:
            lines.append("Notes:")
            for n in self.session_notes[-5:]:
                lines.append(f"  {n}")
        return "\n".join(lines)


# ─── Global session (in-memory, one session at a time) ───────────────────────
SESSION: TradingSessionState = TradingSessionState()


def get_session() -> TradingSessionState:
    return SESSION


def reset_session(symbol: str = "MNQ") -> TradingSessionState:
    global SESSION
    SESSION = TradingSessionState(symbol=symbol)
    return SESSION
