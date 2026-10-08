FROM mcr.microsoft.com/playwright:v1.64.0-jammy

WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies (this will run postinstall and download chromium)
RUN npm install

# Copy the rest of the application
COPY . .

# Run the bot
CMD ["npm", "start"]
