// 以 stream 方式讀完整個 stdin 再解析 JSON，等 Claude Code 寫完輸入、關閉 pipe 才解析。
export async function readJsonStdin(stream = process.stdin) {
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk;
  return JSON.parse(text || '{}');
}
