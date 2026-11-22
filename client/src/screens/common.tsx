import type { ReactNode, ButtonHTMLAttributes } from "react";

export function Button({ variant = "primary", children, ...rest }: { variant?: "primary" | "ghost" | "danger" | "warm" } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button className={`btn btn-${variant}`} {...rest}>
      {children}
    </button>
  );
}

export function Panel({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="panel">
      {title && <h2 className="panel-title">{title}</h2>}
      {children}
    </section>
  );
}

export function Screen({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <main className={`screen ${className}`}>{children}</main>;
}

export const AVATAR_EMOJI: Record<string, string> = {
  bear: "🐻", fox: "🦊", panda: "🐼", rabbit: "🐰", tiger: "🐯", owl: "🦉", frog: "🐸", cat: "🐱",
};
