const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const sink = (levelName) => (msg, fields = {}) => {
    if ((LEVELS[levelName] ?? LEVELS.info) < threshold) return;
    const record = { time: new Date().toISOString(), level: levelName, msg, ...fields };
    const line = JSON.stringify(record);
    if (levelName === 'error') console.error(line);
    else if (levelName === 'warn') console.warn(line);
    else console.log(line);
  };

  return {
    level,
    debug: sink('debug'),
    info: sink('info'),
    warn: sink('warn'),
    error: sink('error'),
    child(fields) {
      return {
        debug: (msg, extra = {}) => sink('debug')(msg, { ...fields, ...extra }),
        info: (msg, extra = {}) => sink('info')(msg, { ...fields, ...extra }),
        warn: (msg, extra = {}) => sink('warn')(msg, { ...fields, ...extra }),
        error: (msg, extra = {}) => sink('error')(msg, { ...fields, ...extra }),
      };
    },
  };
}
