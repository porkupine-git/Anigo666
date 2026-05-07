# 🐳 Docker Deployment Guide for Anixo.online

Follow these steps to deploy your backend on any VPS (Virtual Private Server).

## 1. Prerequisites
Ensure Docker is installed on your server. If not, run:
```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh
```

## 2. Upload Your Code
Clone your repository to the server:
```bash
git clone https://github.com/porkupine-git/AnigoStream-Vercel.git
cd AnigoStream-Vercel
```

## 3. Build the Docker Image
This will build both the frontend (for static files) and the Python backend:
```bash
docker build -t anixo-app .
```

## 4. Run the Container
Run the backend on port 5002:
```bash
docker run -d \
  --name anixo-backend \
  -p 5002:5002 \
  --restart always \
  anixo-app
```

## 5. Verify Deployment
Your backend should now be live at:
`http://YOUR_SERVER_IP:5002/api/home`

## 6. Connecting to Frontend
Update your `frontend/app.js` in Vercel:
```javascript
const PRODUCTION_BACKEND_URL = "http://YOUR_SERVER_IP:5002/api";
```

---

## 💡 Pro Tips:

### Using SSL (HTTPS)
If you want to use `https://api.jeevankart.in`, you should set up a **Reverse Proxy** like Nginx with Certbot (Let's Encrypt). 

### Auto-Update
To update the server whenever you push to GitHub, you can use a simple script or a GitHub Action to SSH into your server and run:
```bash
git pull
docker build -t anixo-app .
docker stop anixo-backend
docker rm anixo-backend
docker run -d --name anixo-backend -p 5002:5002 --restart always anixo-app
```

---
**Happy Hosting!** 🚀🎬
