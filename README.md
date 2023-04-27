Forked from CSGOFLOAT

- Clusterized 
- Using accounts.txt instead of putting 5k user to the config.js
  - Format: `user:pass\n`
- Added proxy support with session handling (you dont have to put 5k proxies to the config.js file)
  - proxy_url: '[socks5|http]://[username][session]:[password]@[url]:[port]',
