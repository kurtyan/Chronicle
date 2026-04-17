# Database & Deployment requirements

## Data high availablity
- Currently the system is using in-memory db, this is quite fragile. Please change to: stable sqlite with db file on disk
- Explain to me how much effort does it take when installing the app to my working machine if I use stable sqllite
- Need to support export and import api
- Add a 'Settings' tab in most left (below tasks and reports), provide export and import function.
- Need to have scheduled hourly backup


## Deployment spec
- when deploying on my working machine, I prefer the server + lauri UI method.
- I will push this project to github and checkout the project from github on my working machine
- Then I will build server & lauri UI from my working machine.
- The server and lauri should support configs:
  - server:
    - read default config from ~/.chronicle
    - configs:
      - bind ip
      - bind port
      - location of database 
  - lauri:
    - read default config from ~/.chronicle
    - configs:
      - server ip
      - server port
- You should explain to me the build method, what would the artifact be like, what's the dependency for both server and lauri UI and how to install them


We are ready to test it on the working machine! Cheer up!