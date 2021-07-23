import { defineConfig } from 'umi';

// ref: https://umijs.org/config/
export default defineConfig({
  ssr: {},
  exportStatic: {},
  nodeModulesTransform: {
    type: 'none',
  },
  antd: {},
  dva: false,
});
