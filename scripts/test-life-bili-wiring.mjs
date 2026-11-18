// test-audit 只 spawn `scripts/<name>`；B站 life 接线的真实测试与其它插件测试一起放在
// `plugins/surfcore/scripts/`。这里只做一层包装，不复制断言（避免两份会漂移的实现）。
//
// 运行：node scripts/test-life-bili-wiring.mjs
await import('../plugins/surfcore/scripts/test-life-bili-wiring.mjs');
