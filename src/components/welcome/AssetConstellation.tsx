import { turtleImage } from "@/lib/turtles";
import { exchangeLogo } from "@/lib/exchange-logos";



/* Crypto marks */
function BTC() {
  return (
    <svg viewBox="0 0 32 32" className="h-full w-full">
      <circle cx="16" cy="16" r="16" fill="#F7931A" />
      <path
        fill="#fff"
        d="M21.7 14.3c.3-1.9-1.2-2.9-3.2-3.6l.7-2.6-1.6-.4-.6 2.6c-.4-.1-.9-.2-1.3-.3l.6-2.6-1.6-.4-.7 2.6c-.4-.1-.7-.2-1-.3l-2.2-.6-.4 1.7s1.2.3 1.2.3c.7.2.8.6.7 1l-.8 3c.1 0 .1 0 .2.1l-.2-.1-1.1 4.2c-.1.2-.3.5-.8.4 0 0-1.2-.3-1.2-.3l-.8 1.8 2 .5c.4.1.8.2 1.1.3l-.7 2.7 1.6.4.7-2.6c.4.1.9.2 1.3.4l-.7 2.6 1.6.4.7-2.7c2.7.5 4.8.3 5.6-2.2.7-2-.04-3.1-1.5-3.8 1-.2 1.8-.9 2-2.3zm-3.7 5c-.5 2-3.8.9-4.9.7l.9-3.5c1.1.3 4.5.8 4 2.8zm.5-5c-.4 1.8-3.2.9-4.1.7l.8-3.2c.9.3 3.8.7 3.3 2.5z"
      />
    </svg>
  );
}

function ETH() {
  return (
    <svg viewBox="0 0 32 32" className="h-full w-full">
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#fff">
        <path fillOpacity=".6" d="M16.5 4v8.87l7.5 3.35z" />
        <path d="M16.5 4 9 16.22l7.5-3.35z" />
        <path fillOpacity=".6" d="M16.5 21.97v6.02L24 17.62z" />
        <path d="M16.5 27.99v-6.02L9 17.62z" />
        <path fillOpacity=".2" d="m16.5 20.57 7.5-4.35-7.5-3.35z" />
        <path fillOpacity=".6" d="m9 16.22 7.5 4.35v-7.7z" />
      </g>
    </svg>
  );
}

function SOL() {
  return (
    <svg viewBox="0 0 32 32" className="h-full w-full">
      <circle cx="16" cy="16" r="16" fill="#0B0F14" />
      <defs>
        <linearGradient id="solg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9945FF" />
          <stop offset="100%" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <g fill="url(#solg)">
        <path d="M9 21.5l2-2h12l-2 2H9zm0-5l2-2h12l-2 2H9zm0-5l2-2h12l-2 2H9z" />
      </g>
    </svg>
  );
}

function XRP() {
  return (
    <svg viewBox="0 0 32 32" className="h-full w-full">
      <circle cx="16" cy="16" r="16" fill="#000" />
      <path
        fill="#fff"
        d="M22 9h2.5l-5.2 5.1a4.7 4.7 0 0 1-6.6 0L7.5 9H10l4 3.9a3 3 0 0 0 4 0L22 9zM10 23H7.5l5.2-5.1a4.7 4.7 0 0 1 6.6 0L24.5 23H22l-4-3.9a3 3 0 0 0-4 0L10 23z"
      />
    </svg>
  );
}


/* Brand logo chip using local exchange asset */
function BrandChip({ id, ring = "rgba(255,255,255,0.14)", label }: { id: string; ring?: string; label: string }) {
  const src = exchangeLogo(id);
  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-hidden rounded-2xl bg-[#0B0F14] p-1 backdrop-blur-md"
      style={{ border: `1px solid ${ring}` }}
    >
      {src ? (
        <img src={src} alt={label} loading="lazy" className="h-full w-full rounded-xl object-contain" />
      ) : (
        <span className="text-[10px] font-bold text-white">{label}</span>
      )}
    </div>
  );
}



type Node = {
  key: string;
  pos: string;
  size: number;
  drift: "drift-a" | "drift-b" | "drift-c" | "drift-d";
  z: number;
  glow: string;
  render: React.ReactNode;
};

const NODES: Node[] = [
  // Top corners — clear of the headline above
  { key: "btc",   pos: "left-[-2%] top-[8%]",     size: 40, drift: "drift-a", z: 30, glow: "rgba(247,147,26,0.45)", render: <BTC /> },
  { key: "eth",   pos: "right-[-2%] top-[8%]",    size: 40, drift: "drift-b", z: 30, glow: "rgba(98,126,234,0.45)", render: <ETH /> },

  // Mid sides — orbit the mascot's shoulders
  { key: "sol",   pos: "left-[-4%] top-[44%]",    size: 38, drift: "drift-c", z: 25, glow: "rgba(153,69,255,0.45)", render: <SOL /> },
  { key: "xrp",   pos: "right-[-4%] top-[44%]",   size: 38, drift: "drift-d", z: 25, glow: "rgba(255,255,255,0.35)", render: <XRP /> },

  // Exchange marks — lower sides
  { key: "coinbase", pos: "left-[-3%] bottom-[14%]", size: 44, drift: "drift-b", z: 22, glow: "rgba(22,82,240,0.42)", render: <BrandChip id="coinbase" ring="rgba(22,82,240,0.38)" label="Coinbase" /> },
  { key: "kraken", pos: "right-[-3%] bottom-[14%]", size: 44, drift: "drift-a", z: 22, glow: "rgba(113,50,245,0.42)", render: <BrandChip id="kraken" ring="rgba(113,50,245,0.38)" label="Kraken" /> },
];

export function AssetConstellation() {
  const src = turtleImage("dca");
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[240px]">

      {/* Soft ambient glow */}
      <div
        className="pointer-events-none absolute inset-x-8 bottom-0 top-10 rounded-[40%] blur-3xl"
        style={{ background: "radial-gradient(closest-side, rgba(168,85,247,0.16), transparent 70%)" }}
      />

      {/* Official Accumulator turtle from src/lib/turtles.ts */}
      <div className="absolute inset-x-[8%] bottom-[2%] top-[4%] flex items-end justify-center">
        <img
          src={src}
          alt="Turtle Bot"
          className="h-full w-full object-contain object-bottom"
          style={{ filter: "drop-shadow(0 30px 40px rgba(0,0,0,0.6)) drop-shadow(0 0 30px rgba(168,85,247,0.18))" }}
        />

      </div>

      {/* Asset / brand chips orbiting the figure */}
      {NODES.map((n) => (
        <div
          key={n.key}
          className={`absolute ${n.pos} ${n.drift}`}
          style={{ width: n.size, height: n.size, zIndex: n.z, filter: `drop-shadow(0 8px 24px ${n.glow})` }}
        >
          {n.render}
        </div>
      ))}
    </div>
  );
}
