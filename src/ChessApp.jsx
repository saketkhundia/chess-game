import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Chess } from "chess.js";

// React Chess — no Tailwind, vanilla CSS classes
// - Click-to-move with legal move dots
// - Promotion dialog
// - Move history, PGN/FEN, load FEN
// - Undo/Reset, flip board, simple bot (random moves)
// - LocalStorage autosave
// - Sound effects on capture
// - Enhanced piece visuals
// - Better legal move indicators

const LS_KEY = "react-chess-game-vanilla-v1";

const PIECE_IMAGES = {
  w: {
    k: "https://upload.wikimedia.org/wikipedia/commons/4/42/Chess_klt45.svg",
    q: "https://upload.wikimedia.org/wikipedia/commons/1/15/Chess_qlt45.svg",
    r: "https://upload.wikimedia.org/wikipedia/commons/7/72/Chess_rlt45.svg",
    b: "https://upload.wikimedia.org/wikipedia/commons/b/b1/Chess_blt45.svg",
    n: "https://upload.wikimedia.org/wikipedia/commons/7/70/Chess_nlt45.svg",
    p: "https://upload.wikimedia.org/wikipedia/commons/4/45/Chess_plt45.svg",
  },
  b: {
    k: "https://upload.wikimedia.org/wikipedia/commons/f/f0/Chess_kdt45.svg",
    q: "https://upload.wikimedia.org/wikipedia/commons/4/47/Chess_qdt45.svg",
    r: "https://upload.wikimedia.org/wikipedia/commons/f/ff/Chess_rdt45.svg",
    b: "https://upload.wikimedia.org/wikipedia/commons/9/98/Chess_bdt45.svg",
    n: "https://upload.wikimedia.org/wikipedia/commons/e/ef/Chess_ndt45.svg",
    p: "https://upload.wikimedia.org/wikipedia/commons/c/c7/Chess_pdt45.svg",
  },
};

// Sound utility class
class SoundPlayer {
  constructor() {
    this.audioContext = null;
    this.isMuted = false;
  }

  getAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this.audioContext;
  }

  // Generate a simple capture sound
  playCapture() {
    if (this.isMuted) return;
    try {
      const ctx = this.getAudioContext();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      // Sharp sound for capture
      osc.frequency.setValueAtTime(400, now);
      osc.frequency.exponentialRampToValueAtTime(200, now + 0.1);

      gain.gain.setValueAtTime(0.3, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

      osc.start(now);
      osc.stop(now + 0.1);
    } catch (e) {
      console.log("Audio not supported");
    }
  }

  // Generate a move sound (softer)
  playMove() {
    if (this.isMuted) return;
    try {
      const ctx = this.getAudioContext();
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      // Softer sound for regular moves
      osc.frequency.setValueAtTime(300, now);
      osc.frequency.exponentialRampToValueAtTime(150, now + 0.05);

      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.05);

      osc.start(now);
      osc.stop(now + 0.05);
    } catch (e) {
      console.log("Audio not supported");
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    return this.isMuted;
  }
}

// Global sound player instance
const soundPlayer = new SoundPlayer();

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];

function formatEngineScore(scoreType, scoreValue) {
  if (scoreType === "mate") {
    return `Mate in ${Math.abs(scoreValue)}`;
  }
  if (scoreType === "cp") {
    const pawns = (scoreValue / 100).toFixed(2);
    return `${scoreValue >= 0 ? "+" : ""}${pawns}`;
  }
  return "--";
}

function parseUciMove(uciMove) {
  if (!uciMove || uciMove === "(none)" || uciMove.length < 4) return null;
  return {
    from: uciMove.slice(0, 2),
    to: uciMove.slice(2, 4),
    promotion: uciMove.length > 4 ? uciMove[4] : undefined,
  };
}

function toUciFromMove(move) {
  if (!move) return "";
  return `${move.from}${move.to}${move.promotion || ""}`;
}

function classifyMove(centipawnLoss, playedUci, bestUci, moveMeta) {
  const isBest = playedUci && bestUci && playedUci === bestUci;
  const isBrilliantTactic =
    isBest &&
    !!moveMeta?.captured &&
    moveMeta?.piece !== "p" &&
    ["r", "q"].includes(moveMeta.captured);

  if (isBrilliantTactic) return "Brilliant";
  if (isBest || centipawnLoss <= 20) return "Best";
  if (centipawnLoss <= 60) return "Good";
  if (centipawnLoss <= 120) return "Inaccuracy";
  if (centipawnLoss <= 220) return "Mistake";
  return "Blunder";
}

function getDifficultyProfile(depthValue) {
  if (depthValue <= 8) {
    return { label: "easy", engineDepth: 6, randomMoveChance: 0.6, thinkMs: 200 };
  }
  if (depthValue <= 11) {
    return { label: "medium", engineDepth: 9, randomMoveChance: 0.25, thinkMs: 250 };
  }
  if (depthValue <= 14) {
    return { label: "hard", engineDepth: 14, randomMoveChance: 0.05, thinkMs: 300 };
  }
  return { label: "expert", engineDepth: 18, randomMoveChance: 0, thinkMs: 350 };
}

function scoreToWhiteCp(scoreType, scoreValue) {
  if (typeof scoreValue !== "number") return 0;
  if (scoreType === "cp") return scoreValue;
  if (scoreType === "mate") {
    const sign = scoreValue >= 0 ? 1 : -1;
    const distance = Math.max(1, Math.abs(scoreValue));
    return sign * (100000 - distance * 1000);
  }
  return 0;
}

function accuracyFromAvgLoss(avgLoss) {
  const raw = 100 * Math.exp(-avgLoss / 300);
  return Math.max(0, Math.min(100, raw));
}

function useChess(initialFen) {
  const [fen, setFen] = useState(initialFen || new Chess().fen());
  const [pgn, setPgn] = useState("");

  const gameRef = useRef(null);
  if (!gameRef.current) gameRef.current = new Chess(fen);

  useEffect(() => {
    const g = new Chess();
    try {
      g.load(fen);
    } catch (e) {
      g.reset();
    }
    gameRef.current = g;
    setPgn(g.pgn());
  }, [fen]);

  const api = useMemo(() => {
    return {
      get game() {
        return gameRef.current;
      },
      setFen,
      move(m) {
        const g = gameRef.current;
        const result = g.move(m);
        if (result) {
          setFen(g.fen());
          setPgn(g.pgn());
        }
        return result;
      },
      undo() {
        const g = gameRef.current;
        const u = g.undo();
        if (u) {
          setFen(g.fen());
          setPgn(g.pgn());
        }
        return u;
      },
      reset() {
        const g = new Chess();
        gameRef.current = g;
        setFen(g.fen());
        setPgn("");
      },
      loadFEN(f) {
        const g = new Chess();
        g.load(f);
        gameRef.current = g;
        setFen(g.fen());
        setPgn(g.pgn());
      },
    };
  }, []);

  return { fen, pgn, ...api };
}

function Header({
  turn,
  inCheck,
  statusText,
  onReset,
  onUndo,
  onFlip,
  flipped,
  vsBot,
  setVsBot,
  soundMuted,
  onToggleMute,
  view,
  onOpenBoard,
  onOpenAnalysis,
}) {
  return (
    <div className="header">
      <div className="title-group">
        <div className="eyebrow">Strategy Board</div>
        <div className="title">Chess Studio</div>
        <div className="subtitle">
          Turn: <span className="bold">{turn === "w" ? "White" : "Black"}</span>
          {inCheck ? <span className="in-check"> in check</span> : null}
        </div>
        <div className="status">{statusText}</div>
      </div>
      <div className="actions">
        <button className={`btn secondary ${view === "play" ? "active-tab" : ""}`} onClick={onOpenBoard}>Play</button>
        <button className={`btn secondary ${view === "analysis" ? "active-tab" : ""}`} onClick={onOpenAnalysis}>Analyze</button>
        <label className="checkbox">
          <input type="checkbox" checked={vsBot} onChange={(e) => setVsBot(e.target.checked)} />
          <span>Play vs Bot</span>
        </label>
        <button className="btn secondary" onClick={onFlip}>{flipped ? "White at bottom" : "Black at bottom"}</button>
        <button className="btn secondary" onClick={onUndo}>Undo</button>
        <button className="btn danger" onClick={onReset}>Reset</button>
        <button className="btn sound-btn" onClick={onToggleMute} title={soundMuted ? "Unmute" : "Mute"}>
          {soundMuted ? "🔇" : "🔊"}
        </button>
      </div>
    </div>
  );
}

function AnalysisPage({ gameReview, reviewingGame, onRunGameAnalysis }) {
  const reviewedMoves = gameReview?.moves || [];

  return (
    <div className="analysis-page">
      <div className="analysis-header">
        <div>
          <div className="board-title">Post-Game Analysis</div>
          <div className="board-meta">Stockfish review with move quality and accuracy</div>
        </div>
        <button className="btn secondary" onClick={onRunGameAnalysis} disabled={reviewingGame}>
          {reviewingGame ? "Analyzing..." : "Run Analysis"}
        </button>
      </div>

      <div className="analysis-summary">
        <div className="analysis-card">
          <div className="panel-title">White Accuracy</div>
          <div className="accuracy-value">{gameReview ? `${gameReview.whiteAccuracy.toFixed(1)}%` : "--"}</div>
        </div>
        <div className="analysis-card">
          <div className="panel-title">Black Accuracy</div>
          <div className="accuracy-value">{gameReview ? `${gameReview.blackAccuracy.toFixed(1)}%` : "--"}</div>
        </div>
        <div className="analysis-card">
          <div className="panel-title">Moves Reviewed</div>
          <div className="accuracy-value">{gameReview ? gameReview.plies : "--"}</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Move Quality</div>
        <div className="analysis-table-wrap">
          <table className="analysis-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Player</th>
                <th>Played</th>
                <th>Best</th>
                <th>Loss</th>
                <th>Grade</th>
              </tr>
            </thead>
            <tbody>
              {reviewedMoves.length === 0 ? (
                <tr>
                  <td colSpan={6} className="analysis-empty">Run analysis to see move-by-move grading.</td>
                </tr>
              ) : (
                reviewedMoves.map((m) => (
                  <tr key={m.ply}>
                    <td>{m.ply}</td>
                    <td>{m.player === "w" ? "White" : "Black"}</td>
                    <td>{m.playedSan}</td>
                    <td>{m.bestMove || "--"}</td>
                    <td>{Math.round(m.loss)}</td>
                    <td>
                      <span className={`move-grade grade-${m.grade.toLowerCase()}`}>{m.grade}</span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function PromotionPicker({ color, onPick, onClose }) {
  const pieces = ["q", "r", "b", "n"]; // queen, rook, bishop, knight
  return (
    <div className="modal-overlay">
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className="modal-card"
      >
        <div className="modal-title">Choose promotion</div>
        <div className="modal-grid">
          {pieces.map((p) => (
            <button
              key={p}
              onClick={() => onPick(p)}
              className="promo-btn"
              aria-label={`Promote to ${p}`}
            >
              <img src={PIECE_IMAGES[color][p]} alt={`${color === "w" ? "White" : "Black"} ${p}`} className="piece-img" />
            </button>
          ))}
        </div>
        <button onClick={onClose} className="btn full">Cancel</button>
      </motion.div>
    </div>
  );
}

function SidePanel({
  pgn,
  fen,
  history,
  onCopyPGN,
  onCopyFEN,
  onLoadFEN,
  analysis,
  engineReady,
  botThinking,
  botDepth,
  setBotDepth,
  gameReview,
  reviewingGame,
  onRunGameAnalysis,
}) {
  const [fenInput, setFenInput] = useState("");
  return (
    <div className="sidepanel">
      <div className="panel">
        <div className="panel-title">Engine</div>
        <div className="engine-grid">
          <div className="engine-row">
            <span>Status</span>
            <span className={`engine-badge ${engineReady ? "ok" : "loading"}`}>
              {engineReady ? (botThinking ? "Thinking" : "Ready") : "Loading"}
            </span>
          </div>
          <div className="engine-row">
            <span>Evaluation</span>
            <span>{analysis.evaluation}</span>
          </div>
          <div className="engine-row">
            <span>Depth</span>
            <span>{analysis.depth || "--"}</span>
          </div>
          <div className="engine-row">
            <span>Best move</span>
            <span>{analysis.bestMove || "--"}</span>
          </div>
        </div>
        <div className="hint">Bot strength (search depth)</div>
        <select
          value={botDepth}
          onChange={(e) => setBotDepth(Number(e.target.value))}
          className="input"
        >
          <option value={8}>Easy</option>
          <option value={11}>Medium</option>
          <option value={14}>Hard</option>
          <option value={18}>Expert</option>
        </select>
      </div>

      <div className="panel">
        <div className="panel-title">Game Analysis</div>
        <div className="engine-grid">
          <div className="engine-row">
            <span>White accuracy</span>
            <span>{gameReview ? `${gameReview.whiteAccuracy.toFixed(1)}%` : "--"}</span>
          </div>
          <div className="engine-row">
            <span>Black accuracy</span>
            <span>{gameReview ? `${gameReview.blackAccuracy.toFixed(1)}%` : "--"}</span>
          </div>
          <div className="engine-row">
            <span>Moves analyzed</span>
            <span>{gameReview ? gameReview.plies : "--"}</span>
          </div>
        </div>
        <div className="row-gap">
          <button className="btn secondary full" onClick={onRunGameAnalysis} disabled={reviewingGame || !engineReady}>
            {reviewingGame ? "Analyzing..." : "Analyze Game Accuracy"}
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Moves</div>
        <div className="moves">
          <ol className="moves-list">
            {history.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ol>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">PGN</div>
        <textarea readOnly value={pgn} className="textarea small" />
        <button onClick={onCopyPGN} className="btn">Copy PGN</button>
      </div>

      <div className="panel">
        <div className="panel-title">FEN</div>
        <textarea readOnly value={fen} className="textarea small" />
        <div className="row-gap">
          <button onClick={onCopyFEN} className="btn">Copy FEN</button>
        </div>
        <div className="hint">Load FEN</div>
        <input
          value={fenInput}
          onChange={(e) => setFenInput(e.target.value)}
          placeholder="Paste a FEN and press Load"
          className="input"
        />
        <button onClick={() => onLoadFEN(fenInput)} className="btn">Load</button>
      </div>
    </div>
  );
}

function Board({ game, onUserMove, flipped }) {
  const [selected, setSelected] = useState(null); // square like "e2"
  const [legalTargets, setLegalTargets] = useState([]);
  const [draggedFrom, setDraggedFrom] = useState(null);
  const [dragOverSquare, setDragOverSquare] = useState(null);
  const fenKey = game.fen();

  useEffect(() => {
    setSelected(null);
    setLegalTargets([]);
  }, [fenKey]);

  const files = flipped ? [...FILES].reverse() : FILES;
  // always render rank 8 at top visually, flip only left-right when flipped
  const ranks = [...RANKS].reverse();

  function onSquareClick(sq) {
    const piece = game.get(sq);

    if (!selected) {
      if (piece && piece.color === game.turn()) {
        setSelected(sq);
        const moves = game.moves({ square: sq, verbose: true });
        setLegalTargets(moves.map((m) => m.to));
      }
      return;
    }

    if (piece && piece.color === game.turn() && sq !== selected) {
      setSelected(sq);
      const moves = game.moves({ square: sq, verbose: true });
      setLegalTargets(moves.map((m) => m.to));
      return;
    }

    const moves = game.moves({ square: selected, verbose: true });
    const match = moves.find((m) => m.to === sq);
    if (!match) {
      setSelected(null);
      setLegalTargets([]);
      return;
    }

    if (match.flags.includes("p")) {
      onUserMove({ from: selected, to: sq, needsPromotion: true, isCapture: match.flags.includes("c") });
    } else {
      onUserMove({ from: selected, to: sq, isCapture: match.flags.includes("c") });
    }
    setSelected(null);
    setLegalTargets([]);
  }

  function tryMove(from, to) {
    if (!from || !to || from === to) return false;
    const moves = game.moves({ square: from, verbose: true });
    const match = moves.find((m) => m.to === to);
    if (!match) return false;

    if (match.flags.includes("p")) {
      onUserMove({ from, to, needsPromotion: true, isCapture: match.flags.includes("c") });
    } else {
      onUserMove({ from, to, isCapture: match.flags.includes("c") });
    }
    setSelected(null);
    setLegalTargets([]);
    return true;
  }

  function startDrag(from) {
    const piece = game.get(from);
    if (!piece || piece.color !== game.turn()) return;
    setDraggedFrom(from);
    setSelected(from);
    const moves = game.moves({ square: from, verbose: true });
    setLegalTargets(moves.map((m) => m.to));
  }

  function finishDrag(to) {
    if (!draggedFrom) return;
    tryMove(draggedFrom, to);
    setDraggedFrom(null);
    setDragOverSquare(null);
  }

  function getSquareFromPoint(x, y) {
    const element = document.elementFromPoint(x, y);
    const sqEl = element?.closest?.("[data-square]");
    return sqEl?.getAttribute("data-square") || null;
  }

  const squares = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const file = files[f];
      const rank = ranks[r];
      const sq = `${file}${rank}`;
      const piece = game.get(sq);
      const isDark = (f + (7 - r)) % 2 === 1; // alternate colors
      const isSelected = selected === sq;
      const isLastMoveSquare = (() => {
        const hist = game.history({ verbose: true });
        if (!hist.length) return false;
        const last = hist[hist.length - 1];
        return last.from === sq || last.to === sq;
      })();
      const isTarget = legalTargets.includes(sq);

      squares.push(
        <div
          key={sq}
          data-square={sq}
          className={`square ${isDark ? "dark" : "light"} ${isSelected ? "selected" : ""} ${isLastMoveSquare ? "last-move" : ""} ${dragOverSquare === sq ? "drag-over" : ""}`}
          onClick={() => onSquareClick(sq)}
          onDragOver={(e) => {
            e.preventDefault();
            if (draggedFrom) setDragOverSquare(sq);
          }}
          onDragEnter={() => {
            if (draggedFrom) setDragOverSquare(sq);
          }}
          onDrop={(e) => {
            e.preventDefault();
            finishDrag(sq);
          }}
        >
          {/* rank/file labels */}
          <div className="label tl">{file === files[0] ? rank : ""}</div>
          <div className="label br">{rank === ranks[7] ? file : ""}</div>

          {/* Legal move indicators */}
          {isTarget && (
            <motion.div
              layoutId={`dot-${sq}`}
              className={`legal-dot ${piece ? "has-capture" : ""}`}
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
            />
          )}

          {piece && (
            <motion.div
              layoutId={`piece-${sq}-${piece.type}-${piece.color}`}
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className={`piece-wrapper ${draggedFrom === sq ? "dragging" : ""}`}
              draggable={piece.color === game.turn()}
              onDragStart={(e) => {
                startDrag(sq);
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", sq);
              }}
              onDragEnd={() => {
                setDraggedFrom(null);
                setDragOverSquare(null);
              }}
              onTouchStart={(e) => {
                startDrag(sq);
              }}
              onTouchMove={(e) => {
                const touch = e.touches[0];
                if (!touch || !draggedFrom) return;
                const touchSq = getSquareFromPoint(touch.clientX, touch.clientY);
                setDragOverSquare(touchSq);
              }}
              onTouchEnd={() => {
                finishDrag(dragOverSquare);
              }}
            >
              <img
                src={PIECE_IMAGES[piece.color][piece.type]}
                alt={`${piece.color === "w" ? "White" : "Black"} ${piece.type}`}
                className="piece-img"
              />
            </motion.div>
          )}
        </div>
      );
    }
  }

  return <div className="board">{squares}</div>;
}

export default function ChessApp() {
  const saved = useMemo(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, []);

  const { fen, pgn, game, move, undo, reset, loadFEN } = useChess(saved?.fen);
  const [flipped, setFlipped] = useState(saved?.flipped || false);
  const [vsBot, setVsBot] = useState(saved?.vsBot || false);
  const [promotion, setPromotion] = useState(null); // { from, to }
  const [statusText, setStatusText] = useState("");
  const [soundMuted, setSoundMuted] = useState(saved?.soundMuted || false);
  const [botDepth, setBotDepth] = useState(saved?.botDepth || 14);
  const [analysis, setAnalysis] = useState({ evaluation: "--", depth: 0, bestMove: "--" });
  const [engineReady, setEngineReady] = useState(false);
  const [botThinking, setBotThinking] = useState(false);
  const [engineLabel, setEngineLabel] = useState("WASM");
  const [gameReview, setGameReview] = useState(null);
  const [reviewingGame, setReviewingGame] = useState(false);
  const [view, setView] = useState("play");

  const stockfishRef = useRef(null);
  const engineModeRef = useRef("idle");
  const analysisTimerRef = useRef(null);
  const reviewEvalRef = useRef(null);
  const engineRestartCountRef = useRef(0);

  useEffect(() => {
    soundPlayer.isMuted = soundMuted;
  }, [soundMuted]);

  useEffect(() => {
    const payload = { fen, flipped, vsBot, soundMuted, botDepth };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {}
  }, [fen, flipped, vsBot, soundMuted, botDepth]);

  const historySAN = game.history();

  useEffect(() => {
    const engineCandidates = [
      { file: "stockfish-18-asm.js", label: "ASM stable" },
    ];
    let activeWorker = null;
    let disposed = false;

    const onMessage = (event) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;

      if (text === "uciok" || text === "readyok") {
        engineRestartCountRef.current = 0;
        setEngineReady(true);
      }

      if (text.startsWith("info depth") && engineModeRef.current === "analysis") {
        const depthMatch = text.match(/\bdepth\s+(\d+)/);
        const cpMatch = text.match(/\bscore\s+cp\s+(-?\d+)/);
        const mateMatch = text.match(/\bscore\s+mate\s+(-?\d+)/);
        const pvMatch = text.match(/\bpv\s+([a-h][1-8][a-h][1-8][qrbn]?)/);

        const scoreType = mateMatch ? "mate" : cpMatch ? "cp" : null;
        const scoreValue = mateMatch ? Number(mateMatch[1]) : cpMatch ? Number(cpMatch[1]) : null;

        setAnalysis((prev) => ({
          evaluation: scoreType ? formatEngineScore(scoreType, scoreValue) : prev.evaluation,
          depth: depthMatch ? Number(depthMatch[1]) : prev.depth,
          bestMove: pvMatch ? pvMatch[1] : prev.bestMove,
        }));
      }

      if (text.startsWith("info depth") && engineModeRef.current === "review") {
        const cpMatch = text.match(/\bscore\s+cp\s+(-?\d+)/);
        const mateMatch = text.match(/\bscore\s+mate\s+(-?\d+)/);
        const pvMatch = text.match(/\bpv\s+([a-h][1-8][a-h][1-8][qrbn]?)/);
        const scoreType = mateMatch ? "mate" : cpMatch ? "cp" : null;
        const scoreValue = mateMatch ? Number(mateMatch[1]) : cpMatch ? Number(cpMatch[1]) : null;
        if (reviewEvalRef.current && scoreType) {
          reviewEvalRef.current.lastCp = scoreToWhiteCp(scoreType, scoreValue);
        }
        if (reviewEvalRef.current && pvMatch) {
          reviewEvalRef.current.lastBestMove = pvMatch[1];
        }
      }

      if (text.startsWith("bestmove")) {
        const parts = text.split(" ");
        const bestMove = parts[1];

        if (engineModeRef.current === "bot") {
          const parsed = parseUciMove(bestMove);
          if (parsed && !game.isGameOver()) {
            try {
              const testGame = new Chess(game.fen());
              const testMove = testGame.move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion }, { sloppy: false });
              if (testMove) {
                move({ from: parsed.from, to: parsed.to, promotion: parsed.promotion });
              }
            } catch (e) {
              // Move is invalid, silently ignore
            }
          }
          setBotThinking(false);
          engineModeRef.current = "idle";
        } else if (engineModeRef.current === "analysis") {
          setAnalysis((prev) => ({ ...prev, bestMove: bestMove || prev.bestMove }));
          engineModeRef.current = "idle";
        } else if (engineModeRef.current === "review") {
          if (reviewEvalRef.current?.resolve) {
            reviewEvalRef.current.resolve({
              cp: reviewEvalRef.current.lastCp ?? 0,
              bestMove: bestMove || reviewEvalRef.current.lastBestMove || "",
            });
            reviewEvalRef.current = null;
          }
          engineModeRef.current = "idle";
        }
      }
    };

    const bootEngine = (candidateIndex) => {
      if (disposed) return;
      const maxRestarts = 6;
      const candidate = engineCandidates[candidateIndex];
      if (!candidate) {
        setEngineReady(false);
        setBotThinking(false);
        setAnalysis({ evaluation: "Engine unavailable", depth: 0, bestMove: "--" });
        return;
      }

      setEngineReady(false);
      setBotThinking(false);
      setEngineLabel(candidate.label);

      const worker = new Worker(`${process.env.PUBLIC_URL}/stockfish/${candidate.file}`);
      activeWorker = worker;
      stockfishRef.current = worker;

      worker.onmessage = onMessage;
      worker.onerror = (errorEvent) => {
        errorEvent.preventDefault();
        if (disposed) return;

         if (reviewEvalRef.current?.resolve) {
          reviewEvalRef.current.resolve({
            cp: reviewEvalRef.current.lastCp ?? 0,
            bestMove: reviewEvalRef.current.lastBestMove || "",
          });
          reviewEvalRef.current = null;
        }

        engineModeRef.current = "idle";

        try {
          worker.terminate();
        } catch {}

        if (engineRestartCountRef.current < maxRestarts) {
          engineRestartCountRef.current += 1;
          setEngineReady(false);
          setBotThinking(false);
          setEngineLabel(`${candidate.label} (restarting)`);
          setTimeout(() => {
            bootEngine(candidateIndex);
          }, 250);
        } else if (candidateIndex + 1 < engineCandidates.length) {
          bootEngine(candidateIndex + 1);
        } else {
          setEngineReady(false);
          setBotThinking(false);
          setAnalysis({ evaluation: "Engine unavailable", depth: 0, bestMove: "--" });
        }
      };

      worker.postMessage("uci");
      worker.postMessage("isready");
    };

    bootEngine(0);

    return () => {
      disposed = true;
      if (analysisTimerRef.current) {
        clearTimeout(analysisTimerRef.current);
        analysisTimerRef.current = null;
      }
      if (activeWorker) {
        try {
          activeWorker.postMessage("quit");
        } catch {}
        try {
          activeWorker.terminate();
        } catch {}
      }
      stockfishRef.current = null;
    };
  }, [move]);

  function evaluateFenCp(fenToAnalyze, depth = 11) {
    return new Promise((resolve) => {
      const worker = stockfishRef.current;
      if (!worker || !engineReady) {
        resolve({ cp: 0, bestMove: "" });
        return;
      }

      const timeoutId = setTimeout(() => {
        if (reviewEvalRef.current?.resolve) {
          reviewEvalRef.current.resolve({
            cp: reviewEvalRef.current.lastCp ?? 0,
            bestMove: reviewEvalRef.current.lastBestMove || "",
          });
          reviewEvalRef.current = null;
        }
        engineModeRef.current = "idle";
      }, 8000);

      reviewEvalRef.current = {
        lastCp: 0,
        lastBestMove: "",
        resolve: (payload) => {
          clearTimeout(timeoutId);
          resolve(payload);
        },
      };

      engineModeRef.current = "review";
      worker.postMessage("stop");
      worker.postMessage(`position fen ${fenToAnalyze}`);
      worker.postMessage(`go depth ${depth}`);
    });
  }

  async function runGameAccuracyAnalysis() {
    const worker = stockfishRef.current;
    if (!worker || !engineReady || reviewingGame) return;

    setReviewingGame(true);
    setGameReview(null);

    try {
      const replay = new Chess();
      const verboseMoves = game.history({ verbose: true });
      const fens = [replay.fen()];

      verboseMoves.forEach((m) => {
        replay.move({ from: m.from, to: m.to, promotion: m.promotion });
        fens.push(replay.fen());
      });

      const evaluations = [];
      for (let i = 0; i < fens.length; i += 1) {
        const result = await evaluateFenCp(fens[i], 10);
        evaluations.push(result);
      }

      let whiteLossTotal = 0;
      let blackLossTotal = 0;
      let whiteMoves = 0;
      let blackMoves = 0;
      const gradedMoves = [];

      for (let ply = 1; ply < evaluations.length; ply += 1) {
        const before = evaluations[ply - 1].cp;
        const after = evaluations[ply].cp;
        const whiteToMovePlayed = ply % 2 === 1;
        const moveMeta = verboseMoves[ply - 1];
        const playedUci = toUciFromMove(moveMeta);
        const bestUci = evaluations[ply - 1].bestMove;
        const loss = whiteToMovePlayed ? Math.max(0, before - after) : Math.max(0, after - before);
        const grade = classifyMove(loss, playedUci, bestUci, moveMeta);

        gradedMoves.push({
          ply,
          player: whiteToMovePlayed ? "w" : "b",
          playedSan: moveMeta?.san || playedUci,
          playedUci,
          bestMove: bestUci,
          loss,
          grade,
        });

        if (whiteToMovePlayed) {
          whiteLossTotal += loss;
          whiteMoves += 1;
        } else {
          blackLossTotal += loss;
          blackMoves += 1;
        }
      }

      const whiteAvgLoss = whiteMoves ? whiteLossTotal / whiteMoves : 0;
      const blackAvgLoss = blackMoves ? blackLossTotal / blackMoves : 0;

      setGameReview({
        whiteAccuracy: accuracyFromAvgLoss(whiteAvgLoss),
        blackAccuracy: accuracyFromAvgLoss(blackAvgLoss),
        whiteAvgLoss,
        blackAvgLoss,
        plies: Math.max(0, evaluations.length - 1),
        moves: gradedMoves,
      });
      setView("analysis");
    } finally {
      setReviewingGame(false);
      engineModeRef.current = "idle";
      reviewEvalRef.current = null;
    }
  }

  useEffect(() => {
    let text = "";
    if (game.isGameOver()) {
      if (game.isCheckmate()) {
        text = `Checkmate. ${game.turn() === "w" ? "Black" : "White"} wins.`;
      } else if (game.isDraw()) {
        text = "Draw.";
      } else if (game.isStalemate()) {
        text = "Stalemate.";
      } else if (game.isThreefoldRepetition()) {
        text = "Draw by threefold repetition.";
      } else if (game.isInsufficientMaterial()) {
        text = "Draw by insufficient material.";
      } else {
        text = "Game over.";
      }
    } else if (game.inCheck()) {
      text = `${game.turn() === "w" ? "White" : "Black"} is in check.`;
    } else {
      text = `Ongoing game.`;
    }
    setStatusText(text);
  }, [fen, game]);

  useEffect(() => {
    const worker = stockfishRef.current;
    if (!worker || !engineReady || game.isGameOver()) return;
    if (reviewingGame) return;

    const userPlays = flipped ? "b" : "w";
    const botColor = userPlays === "w" ? "b" : "w";

    if (!vsBot || game.turn() !== botColor || promotion) return;

    const profile = getDifficultyProfile(botDepth);
    const legal = game.moves({ verbose: true });
    if (!legal.length) return;

    // Easy/medium intentionally inject imperfect play so levels feel different.
    if (Math.random() < profile.randomMoveChance) {
      setBotThinking(true);
      const pick = legal[Math.floor(Math.random() * legal.length)];
      const t = setTimeout(() => {
        move({ from: pick.from, to: pick.to, promotion: pick.promotion });
        setBotThinking(false);
      }, profile.thinkMs);
      return () => clearTimeout(t);
    }

    setBotThinking(true);
    engineModeRef.current = "bot";
    worker.postMessage("stop");
    worker.postMessage(`position fen ${fen}`);
    worker.postMessage(`go depth ${profile.engineDepth}`);
  }, [fen, vsBot, flipped, game, engineReady, botDepth, promotion, reviewingGame, move]);

  useEffect(() => {
    const worker = stockfishRef.current;
    if (!worker || !engineReady || game.isGameOver()) return;
    if (botThinking) return;
    if (reviewingGame) return;
    if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);

    analysisTimerRef.current = setTimeout(() => {
      engineModeRef.current = "analysis";
      worker.postMessage("stop");
      worker.postMessage(`position fen ${fen}`);
      worker.postMessage("go depth 12");
    }, 180);

    return () => {
      if (analysisTimerRef.current) {
        clearTimeout(analysisTimerRef.current);
        analysisTimerRef.current = null;
      }
    };
  }, [fen, engineReady, game, botThinking, reviewingGame]);

  function handleUserMove({ from, to, needsPromotion, isCapture }) {
    if (isCapture) {
      soundPlayer.playCapture();
    } else {
      soundPlayer.playMove();
    }

    if (needsPromotion) {
      setPromotion({ from, to });
      return;
    }
    move({ from, to });
  }

  function onPickPromotion(p) {
    if (!promotion) return;
    move({ from: promotion.from, to: promotion.to, promotion: p });
    setPromotion(null);
    soundPlayer.playMove();
  }

  function copy(text) {
    try {
      navigator.clipboard.writeText(text);
    } catch {}
  }

  return (
    <div className="app">
      <Header
        turn={game.turn()}
        inCheck={game.inCheck()}
        statusText={statusText}
        onReset={reset}
        onUndo={undo}
        onFlip={() => setFlipped((v) => !v)}
        flipped={flipped}
        vsBot={vsBot}
        setVsBot={setVsBot}
        soundMuted={soundMuted}
        onToggleMute={() => setSoundMuted((m) => !m)}
        view={view}
        onOpenBoard={() => setView("play")}
        onOpenAnalysis={() => setView("analysis")}
      />

      {view === "play" ? (
        <div className="layout">
          <div className="board-wrap">
            <div className="board-topline">
              <div className="board-title">Live Board</div>
              <div className="board-meta">{historySAN.length} moves played · Engine: {engineLabel}</div>
            </div>
            <Board game={game} onUserMove={handleUserMove} flipped={flipped} />
          </div>

          <SidePanel
            pgn={pgn}
            fen={fen}
            history={historySAN}
            onCopyPGN={() => copy(pgn)}
            onCopyFEN={() => copy(fen)}
            analysis={analysis}
            engineReady={engineReady}
            botThinking={botThinking}
            botDepth={botDepth}
            setBotDepth={setBotDepth}
            gameReview={gameReview}
            reviewingGame={reviewingGame}
            onRunGameAnalysis={runGameAccuracyAnalysis}
            onLoadFEN={(f) => {
              try {
                loadFEN(f);
              } catch (e) {
                alert("Invalid FEN");
              }
            }}
          />
        </div>
      ) : (
        <AnalysisPage
          gameReview={gameReview}
          reviewingGame={reviewingGame}
          onRunGameAnalysis={runGameAccuracyAnalysis}
        />
      )}

      <div className="footer-note">Click a piece to see legal moves. Blue markers show safe moves, red rings show captures.</div>

      <AnimatePresence>
        {promotion && (
          <PromotionPicker
            color={game.turn()}
            onPick={onPickPromotion}
            onClose={() => setPromotion(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
