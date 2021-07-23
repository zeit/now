import React from 'react';
import { Button } from 'antd';
import styles from './index.less';

export default function Home() {
  const [count, setCount] = React.useState(0);
  return (
    <div className={styles.normal}>
      <div className={styles.welcome} />
      <ul className={styles.list}>
        <li>
          To get started, edit <code>src/pages/index.tsx</code> and save to reload.
        </li>
        <li>
          <a href="https://umijs.org/guide/getting-started.html">Getting Started</a>
        </li>
      </ul>
      <Button onClick={() => setCount(prev => prev + 1)}>Click-{count}</Button>
    </div>
  );
}
