import { useEffect, useState } from "react";
import type { CatalogDevice } from "../lib/catalog";
import { MIN_L1V_BYTES, MIN_L2_BYTES, MIN_MEMORY_BYTES, validateOverrides } from "../lib/deviceOverrides";
import type { SimOverrides } from "../lib/protocol";

type CustomizePanelProps = {
    device: CatalogDevice | null;
    overrides: SimOverrides;
    errors: Record<string, string>;
    saving: boolean;
    runActive: boolean;
  onChange: (next: SimOverrides) => void;
  onSave: () => void;
};

function SizeField({
  id,
  label,
  hint,
  deviceValue,
  value,
  onChange,
  floorBytes,
  error,
  name,
}: {
  id: string;
    name: keyof SimOverrides;
  label: string;
  hint: string;
    floorBytes: number;
    error?: string;
    deviceValue: number | null;
  value: number | undefined;
  onChange: (next: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? "" : String(value));

        useEffect(() => {
    setText(value === undefined ? "" : String(value));
  }, [value]);

  const shown = deviceValue === null ? "—" : formatSize(deviceValue);
  return (
    <div className="customize-field">
      <label htmlFor={id}>
        {label}
        <span className="customize-hint">{hint}</span>
      </label>
      <div className="customize-input">
        <input
          id={id}
          type="number"
          min={floorBytes}
          step={1}
          inputMode="numeric"
          value={text}
          placeholder={`default (${shown})`}
          onChange={(event) => {
            const raw = event.target.value;
            setText(raw);
            // An empty field clears the override rather than setting 0, so "blank"
            // and "zero" cannot both mean the same thing on the wire.
            onChange(raw === "" ? undefined : Math.max(1, Math.floor(Number(raw))));
          }}
          onBlur={() => {
            // A half-typed number ("12e", or a value past i32) is dropped rather than
            // sent: the export takes i32 and would silently truncate.
            const parsed = Number(text);
            if (text !== "" && (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed > 0xffffffff)) {
              setText(value === undefined ? "" : String(value));
            }
          }}
        />
        {error !== undefined && (
          <span className="customize-error" role="alert">{error}</span>
        )}
        <span className="customize-default">
          bytes{deviceValue !== null ? ` · device uses ${shown}` : ""} · min {formatSize(floorBytes)}
        </span>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(bytes % 1024 === 0 ? 0 : 2)} KiB`;
  return `${bytes} B`;
}

export function CustomizePanel({
  device,
  overrides,
  errors,
  saving,
  runActive,
  onChange,
  onSave,
}: CustomizePanelProps) {
  const hasMALL = (device?.memLevels ?? []).includes("MALL");
        const dirty = Object.values(overrides).some((v) => v !== undefined);
  const problems = validateOverrides(overrides, device);
  const blocked = Object.keys(problems).length > 0;

  return (
    <div className="customize">
      <div className="about-view">
        <span className="eyebrow">Simulated hardware</span>
        <h3 className="about-subhead">Cache and memory sizes</h3>
        <p className="table-note">
          Blank uses {device === null ? "the device" : device.label}&rsquo;s own figure. Anything
          typed here applies to the NEXT run and is not remembered after it.
        </p>

        <SizeField
          id="customize-l1v"
          name="l1vBytes"
          error={errors?.["l1vBytes"]}
          label="L1 data cache, per CU"
          hint="one is built per compute unit, so this is not the whole L1"
          deviceValue={device?.l1vBytes ?? null}
          value={overrides.l1vBytes}
          floorBytes={MIN_L1V_BYTES}
          onChange={(l1vBytes) => onChange({ ...overrides, l1vBytes })}
        />
        <SizeField
          id="customize-l2"
          name="l2Bytes"
          error={errors?.["l2Bytes"]}
          label="L2 cache, whole device"
          hint="shared across its banks"
          deviceValue={device?.l2Bytes ?? null}
          value={overrides.l2Bytes}
          floorBytes={MIN_L2_BYTES}
          onChange={(l2Bytes) => onChange({ ...overrides, l2Bytes })}
        />
        {hasMALL ? (
          <SizeField
            id="customize-mall"
            name="mallBytes"
          error={errors?.["mallBytes"]}
            label="MALL (Infinity Cache)"
            hint="between L2 and DRAM on this device"
            deviceValue={device?.mallBytes ?? null}
            value={overrides.mallBytes}
            floorBytes={MIN_L2_BYTES}
            onChange={(mallBytes) => onChange({ ...overrides, mallBytes })}
          />
        ) : (
          <p className="table-note">
            {device === null ? "This device" : device.label} has no MALL, so there is nothing to
            set here.
          </p>
        )}
        <SizeField
          id="customize-memory"
          name="memoryBytes"
          error={errors?.["memoryBytes"]}
          label="Device memory (VRAM)"
          hint="also the limit the allocator enforces, so the gauge and the refusal agree"
          deviceValue={device?.vramBytes ?? null}
          value={overrides.memoryBytes}
          floorBytes={MIN_MEMORY_BYTES}
          onChange={(memoryBytes) => onChange({ ...overrides, memoryBytes })}
        />

        <div className="customize-actions">
          <button
            className="button button-primary"
            onClick={onSave}
            // Disabled rather than hidden while a run is live: the reason it cannot
            // be applied belongs next to the control that would apply it.
            disabled={!dirty || blocked || saving || runActive}
            title={
              blocked
                ? Object.values(problems)[0]
                : runActive
                  ? "cancel or finish the run first: saving rebuilds the simulator"
                  : saving
                    ? "rebuilding the simulator"
                    : !dirty
                      ? "no sizes changed"
                      : "save and rebuild the simulator"
            }
          >
            {saving ? "Rebuilding…" : "Save configuration"}
          </button>
          {dirty && (
            <button className="button" onClick={() => onChange({})} disabled={saving}>
              Reset to device defaults
            </button>
          )}
        </div>
        <p className="table-note">
          Saving rebuilds the simulator so the next run is constructed from these sizes.
          Until then the next run would use the sizes already in force.
        </p>
      </div>
    </div>
  );
}
