/** electron-vite: import tài nguyên tĩnh vào main/preload, trả về đường dẫn file lúc chạy. */
declare module '*?asset' {
  const src: string;
  export default src;
}
