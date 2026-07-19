# Build stage
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_GOOGLE_CLIENT_ID
ENV VITE_GOOGLE_CLIENT_ID=${VITE_GOOGLE_CLIENT_ID}

ARG VITE_GOOGLE_API_KEY
ENV VITE_GOOGLE_API_KEY=${VITE_GOOGLE_API_KEY}

RUN npm run build

# Serve stage
FROM nginx:alpine AS runtime

RUN rm -rf /etc/nginx/conf.d/* /usr/share/nginx/html/*
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
