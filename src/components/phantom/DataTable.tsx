import { useMemo, useState, ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DataColumn<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  sortable?: boolean;
  accessor: (row: T) => string | number | null | undefined;
  render?: (row: T) => ReactNode;
  width?: string;
}

interface DataTableProps<T> {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  className?: string;
  /** Row height in px — density knob (default 56). */
  rowHeight?: number;
}

/**
 * DataTable — desktop-first sortable table primitive.
 *
 * Phantom skin: no borders, tight radius on the outer surface, hairline
 * row separators via bg-white/[0.03], hover row highlight, header row is
 * small-caps 12px text-white/50. Rows are 56px by default.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  className,
  rowHeight = 56,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = col.accessor(a);
      const bv = col.accessor(b);
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return sort.dir === "asc" ? av - bv : bv - av;
      }
      return sort.dir === "asc"
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });
    return copy;
  }, [rows, sort, columns]);

  function toggleSort(key: string, sortable?: boolean) {
    if (!sortable) return;
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: "desc" };
      if (prev.dir === "desc") return { key, dir: "asc" };
      return null;
    });
  }

  if (rows.length === 0 && empty) {
    return (
      <div
        className={cn("rounded-[22px] bg-white/[0.04] p-5 text-center text-white/60", className)}
      >
        {empty}
      </div>
    );
  }

  return (
    <div className={cn("overflow-hidden rounded-[22px] bg-white/[0.04]", className)}>
      <table className="w-full text-[13px]">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    "px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-white/50",
                    c.align === "right" ? "text-right" : "text-left",
                    c.sortable && "cursor-pointer select-none hover:text-white/80",
                  )}
                  onClick={() => toggleSort(c.key, c.sortable)}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.header}
                    {c.sortable &&
                      active &&
                      (sort!.dir === "desc" ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronUp className="h-3 w-3" />
                      ))}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={() => onRowClick?.(row)}
              className={cn(
                "border-t border-white/[0.04] transition-colors",
                onRowClick && "cursor-pointer hover:bg-white/[0.04]",
              )}
              style={{ height: rowHeight }}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    "px-4 tabular-nums text-white/85",
                    c.align === "right" && "text-right",
                  )}
                >
                  {c.render ? c.render(row) : (c.accessor(row) ?? "—")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
