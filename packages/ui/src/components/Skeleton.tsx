import styles from "./Skeleton.module.css";

export interface SkeletonProps {
  height: number;
  width?: string;
}

/** Placeholder block in surface-2; hidden from assistive technology (the container announces "Loading"). */
export function Skeleton({ height, width = "100%" }: SkeletonProps) {
  return <span className={styles.skeleton} style={{ height, width }} aria-hidden="true" />;
}
