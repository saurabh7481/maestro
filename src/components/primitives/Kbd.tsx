import styles from "./Kbd.module.css";

export function Kbd({ children }: { children: string }) {
  return <span className={styles.kbd}>{children}</span>;
}
