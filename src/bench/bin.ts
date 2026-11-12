import { benchMain } from './benchmark';

benchMain().then((code) => {
  process.exitCode = code;
});
