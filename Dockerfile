FROM node:20-alpine

# Install git (needed by some npm packages like @whiskeysockets/baileys)
RUN apk add --no-cache git

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm install --production

# Copy application
COPY . .

# Expose port
EXPOSE 8001

# Start application
CMD ["npm", "start", "dev"]
