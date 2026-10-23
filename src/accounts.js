export function parseAccounts(usernames, passwords) {
  if (!usernames || !passwords) throw new Error("请配置 USERNAMES 和 PASSWORDS");
  const names = usernames.split(",").map((name) => name.trim());
  // Password whitespace is significant. Never trim or filter this list, since
  // doing so could change credentials or pair them with the wrong account.
  const values = passwords.split(",");
  if (names.length !== values.length) throw new Error("用户名和密码的数量不匹配！");
  return names.map((username, index) => {
    if (!username || !values[index]) throw new Error(`账号 #${index + 1} 的用户名或密码为空`);
    return { username, password: values[index] };
  });
}

export function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} 必须是正整数`);
  return number;
}
