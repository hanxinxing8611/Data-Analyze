import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { getDB } from './database/db';
import './index.css';

/* 提前启动数据库初始化（sql.js WASM 下载约 650KB 是首屏最慢环节之一），
   不等 React 渲染完再开始；DataProvider 内的 getDB() 会复用同一个 Promise */
void getDB().catch(() => { /* 错误由 DataProvider 统一处理 */ });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
