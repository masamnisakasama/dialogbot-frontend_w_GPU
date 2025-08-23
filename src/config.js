// config.js
export const API_BASE =
  process.env.REACT_APP_API_BASE ||
  process.env.VITE_API_BASE ||
  process.env.NEXT_PUBLIC_API_BASE ||
  ""; // 空なら相対パスで叩く（devはCRA/ViteのプロキシでOK）