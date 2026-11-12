import React from "react";
import { useCurrentFrame } from "remotion";

type Access = { t: number; bank: number; text: string };

export const BankViz = ({
  title,
  dataShape,
  code,
  formula,
  accesses,
  banks,
  conflictBanks,
}: {
  title: string;
  dataShape: string;
  code: string;
  formula?: string;
  accesses: Access[];
  banks: number[];
  conflictBanks: number[];
}) => {
  const f = useCurrentFrame();
  const step = Math.floor(f / 15);
  return (
    <div style={{ width: 640, height: 360, background: "#111", color: "#fff", fontFamily: "monospace", padding: 20 }}>
      <div style={{ fontSize: 16, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 11, marginBottom: 2 }}>Data: {dataShape}</div>
      <div style={{ fontSize: 11, marginBottom: 2 }}>Code: {code}</div>
      {formula ? (
        <div style={{ fontSize: 11, marginBottom: 8, color: "#8ab4f8" }}>{formula}</div>
      ) : (
        <div style={{ marginBottom: 8 }} />
      )}
      <div style={{ display: "flex", gap: 20 }}>
        <div style={{ flex: 1 }}>
          {accesses.map((a, i) => (
            <div key={i} style={{ fontSize: 10, marginBottom: 2, color: i <= step ? "#fff" : "#555" }}>{a.text}</div>
          ))}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, marginBottom: 4 }}>Banks</div>
          {banks.map((b) => {
            const hit = accesses.slice(0, step + 1).filter((a) => a.bank === b).map((a) => "T" + a.t).join(",");
            const conflict = conflictBanks.includes(b) && hit.split(",").length > 1;
            return (
              <div key={b} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <div style={{ width: 40, height: 24, background: conflict ? "#f44" : "#4f4", textAlign: "center", fontSize: 11 }}>B{b}</div>
                <div style={{ fontSize: 11 }}>{hit || "-"}</div>
              </div>
            );
          })}
          <div style={{ marginTop: 6, fontSize: 11 }}>Now: T{accesses[step].t} to B{accesses[step].bank}</div>
        </div>
      </div>
    </div>
  );
};