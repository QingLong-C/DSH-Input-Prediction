/**
 * 故障留痕的签名归一化（Gitea issue #17 的延伸）。
 *
 * `traceFault` 要节流：同一类故障在一个进程里刷 372 行同样报文本身就是噪声（`_ops` 清空
 * 的 nested 拒绝实测就是这样）。但**按 kind 计数**会犯另一个错：路由缺失报过第一条之后，
 * 第 2..49 次里混进来的任何新故障（锁超时、模型 4xx、投影服务缺失）都会被同一个计数器
 * 一起吞掉——那正是本 issue 批评过的「静默丢弃不可诊断」，而且这次是主动犯。
 *
 * 所以节流按「kind + 归一化签名」分桶：同类只报计数，**新类一定独立报出第一条**。
 * 归一化掉的是"每条都不同但显然同类"的部分：会话 id、耗时、任意数字。
 *
 * @module dsh-suggest-ghost/fault-signature
 */
/**
 * 把一条故障报文归一成"同类必同值"的签名。
 *
 * 步骤是有顺序的：先把 `session-<hex…>` 整体折成 `session`（否则同因故障会被
 * 每个会话拆成独立桶，节流等于没做），再把 `after 1234ms` 折成 `after Nms`
 * （保留字段名，只去掉值），最后把剩余数字一律折成 `N`（状态码、字节数、计数都算同类）。
 *
 * @param message - 原始故障报文（不含 kind）。
 * @returns 归一化签名，用作节流计数键的一部分。
 */
export declare function faultSignature(message: string): string;
