import { Skeleton } from "@workeros/ui/components/skeleton";

/**
 * Tablo-yapılı listeler için tek satırlık skeleton — `mp-table`/`fg-grid`/
 * `collection-grid` gibi grid-template-columns'lu container'ların IÇİNE
 * gömülür, parent grid satırını kendi başına çizer.
 */
export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <>
      {Array.from({ length: cols }).map((_, i) => (
        <Skeleton key={i} className="h-4 w-3/4" />
      ))}
    </>
  );
}

/**
 * Tek başına yerleştirilebilen N-satırlık liste skeletonu. mp-table ve
 * benzeri grid'lerde, "header + n adet SkeletonRow" şeklinde kullan.
 */
export function SkeletonList({ rows = 4, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="mp-row" role="presentation">
          <SkeletonRow cols={cols} />
        </div>
      ))}
    </>
  );
}

/**
 * Kart-yapılı sayfalarda (Overview metrik kartları vb) tek kart placeholder.
 */
export function SkeletonCard({ height = 120 }: { height?: number }) {
  return <Skeleton className="w-full" style={{ height }} />;
}
