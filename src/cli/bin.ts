import { main } from './index';

main().then((code) => {
  process.exitCode = code;
});
