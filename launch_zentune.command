#!/bin/zsh
cd "$(dirname "$0")"

if [ ! -d "node_modules/electron" ]; then
  npm install
fi

npm start
