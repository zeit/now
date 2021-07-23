import React from 'react';
import { Link } from 'umi';
import { Breadcrumb } from 'antd';
import styles from './index.less';

const BasicLayout: React.FC = props => {
  return (
    <div className={styles.normal}>
      <h1 className={styles.title}>Yay! Welcome to umi!</h1>
      <Breadcrumb style={{ margin: '16px 0' }}>
        <Breadcrumb.Item>
          <Link to="/">Home</Link>
        </Breadcrumb.Item>
        <Breadcrumb.Item>
          <Link to="/about">About</Link>
        </Breadcrumb.Item>
      </Breadcrumb>
      {props.children}
    </div>
  );
};

export default BasicLayout;
