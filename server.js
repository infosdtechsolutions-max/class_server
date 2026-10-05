// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const { createCanvas, loadImage } = require("canvas");
const admin = require("firebase-admin");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const bodyParser = require("body-parser");
const https = require("https");
const http = require("http");

// ============================================================
// CONFIG
// ============================================================
const GMAIL_USER = process.env.GMAIL_USER || "info.sdtechsolutions@gmail.com";
const GMAIL_PASS = process.env.GMAIL_APP_PASSWORD || "zjbgimuobirnomro";
const COMPANY_NAME = process.env.COMPANY_NAME || "SD Tech Solutions";
const PORT = process.env.PORT || 5000;
const SERVER_URL = process.env.SERVER_URL || "https://sdtech-server.onrender.com";
const FRONTEND_URL = process.env.FRONTEND_URL || "https://class.sdtechsolutionsorg.com/"; // Change this

// ============================================================
// Firebase Init
// ============================================================
let serviceAccount;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    serviceAccount = require("./serviceAccountKey.json");
  }
} catch (err) {
  console.error("❌ Firebase service account load error:", err.message);
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// ============================================================
// App Setup
// ============================================================
const app = express();

// ✅ FIXED CORS - Proper configuration for Render
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    // Allow all origins in production (you can restrict this later)
    return callback(null, true);
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: [
    "Content-Type", 
    "Authorization", 
    "X-Requested-With",
    "Accept",
    "Origin"
  ],
  credentials: true,
  optionsSuccessStatus: 200
}));

// Handle preflight requests explicitly
app.options("/{*path}", cors());

// ✅ Request logging middleware - Helps debug on Render
app.use((req, res, next) => {
  const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`\n${"═".repeat(60)}`);
  console.log(`📥 [${timestamp}] ${req.method} ${req.url}`);
  console.log(`📍 Origin: ${req.headers.origin || "none"}`);
  console.log(`📍 Content-Type: ${req.headers["content-type"] || "none"}`);
  if (req.body && Object.keys(req.body).length > 0) {
    const safeBody = { ...req.body };
    // Hide sensitive data in logs
    if (safeBody.password) safeBody.password = "***hidden***";
    if (safeBody.otp) safeBody.otp = "***hidden***";
    console.log(`📦 Body:`, JSON.stringify(safeBody, null, 2));
  }
  console.log(`${"═".repeat(60)}`);
  next();
});

app.use(bodyParser.json({ limit: "500mb" }));
app.use(bodyParser.urlencoded({ limit: "500mb", extended: true, parameterLimit: 100000 }));

// ============================================================
// ✅ FIXED Gmail SMTP Transporter
// ============================================================
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // true for 465, false for 587
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASS,
  },
  // tls: {
  //   rejectUnauthorized: false,
  //   minVersion: "TLSv1.2",
  //   ciphers: "SSLv3",
  // },
  connectionTimeout: 20000,
  greetingTimeout: 20000,
  socketTimeout: 30000,
});

// Verify transporter connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error("❌ Gmail SMTP Connection FAILED:", error.message);
    console.error("💡 Possible fixes:");
    console.error("   1. Check if App Password is correct");
    console.error("   2. Ensure 2FA is enabled on Gmail account");
    console.error("   3. Generate new App Password from Google Account settings");
    console.error("   4. Check Render's network allows port 465");
    console.error("💡 Try port 587 with secure:false if 465 fails");
  } else {
    console.log("✅ Gmail SMTP Connected Successfully!");
    console.log(`📧 Sending from: ${GMAIL_USER}`);
  }
});

// ============================================================
// ✅ Email Send Helper Function (Centralized)
// ============================================================
async function sendEmail(mailOptions) {
  return new Promise(async (resolve, reject) => {
    try {
      // Ensure 'from' is properly set
      if (!mailOptions.from) {
        mailOptions.from = `"${COMPANY_NAME}" <${GMAIL_USER}>`;
      }

      console.log(`📧 Attempting to send email to: ${mailOptions.to}`);
      console.log(`📧 Subject: ${mailOptions.subject}`);

      const info = await transporter.sendMail(mailOptions);
      
      console.log(`✅ Email sent successfully!`);
      console.log(`📧 Message ID: ${info.messageId}`);
      console.log(`📧 Response: ${info.response}`);
      
      resolve(info);
    } catch (error) {
      console.error(`❌ Email send FAILED:`);
      console.error(`❌ Error Code: ${error.code}`);
      console.error(`❌ Error Message: ${error.message}`);
      console.error(`❌ Response: ${error.response}`);
      console.error(`❌ Response Code: ${error.responseCode}`);
      
      // Provide helpful error messages
      let userFriendlyError = error.message;
      if (error.code === "EAUTH") {
        userFriendlyError = "Gmail authentication failed. Check App Password.";
      } else if (error.code === "ECONNECTION") {
        userFriendlyError = "Connection failed. Check network/firewall.";
      } else if (error.code === "ETIMEDOUT") {
        userFriendlyError = "Connection timed out. Try again.";
      } else if (error.responseCode === 550) {
        userFriendlyError = "Email rejected by Gmail. Check sender settings.";
      }
      
      reject(new Error(userFriendlyError));
    }
  });
}

// ============================================================
// Global OTP Store
// ============================================================
let otpStore = {};

// ============================================================
// ✅ KEEP ALIVE SYSTEM
// ============================================================
function selfPing() {
  const url = `${SERVER_URL}/health`;
  const client = url.startsWith("https") ? https : http;

  const req = client.get(url, (res) => {
    const now = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
    console.log(`🏓 Keep-Alive Ping: ${res.statusCode} | Time: ${now}`);
  });

  req.on("error", (err) => {
    console.log(`⚠️ Keep-Alive Ping Failed: ${err.message}`);
  });

  req.setTimeout(10000, () => {
    req.destroy();
    console.log("⚠️ Keep-Alive Ping Timeout");
  });
}

// Ping every 13 minutes (Render sleeps at 15 min on free tier)
cron.schedule("*/13 * * * *", () => {
  console.log("⏰ Keep-Alive Cron Triggered...");
  selfPing();
});

// ============================================================
// HEALTH CHECK ROUTE
// ============================================================
app.get("/health", (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);

  res.status(200).json({
    status: "✅ Server is Running",
    company: COMPANY_NAME,
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    timestamp: new Date().toISOString(),
    istTime: new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    memory: {
      used: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
      total: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)} MB`,
    },
    email: {
      configured: !!GMAIL_USER,
      user: GMAIL_USER,
    },
  });
});

// ============================================================
// Home Route
// ============================================================
app.get("/", (req, res) => {
  res.status(200).json({
    status: "✅ Server Running",
    company: COMPANY_NAME,
    port: PORT,
    gmail: GMAIL_USER,
    timestamp: new Date().toISOString(),
    endpoints: [
      "POST /send-otp",
      "POST /verify-otp",
      "POST /send-credentials",
      "POST /send-certificate",
      "POST /generate-certificate",
      "POST /approve-user",
      "POST /test-login",
      "POST /send-password-reset",
      "POST /check-user",
      "GET /upload-lessons",
      "POST /send-invoice",
      "POST /send-email",
      "POST /send-bulk-email",
      "GET /download-backup",
      "POST /restore-backup",
      "GET /health",
    ],
  });
});

// ============================================================
// ✅ SEND OTP - FIXED
// ============================================================
app.post("/send-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: "Email is required" 
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store OTP with expiry
    otpStore[cleanEmail] = {
      otp,
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
    };

    console.log(`✅ OTP Generated for ${cleanEmail}: ${otp}`);

    // Send email
    await sendEmail({
      from: `"${COMPANY_NAME}" <${GMAIL_USER}>`,
      to: cleanEmail,
      subject: "🔐 OTP Verification - SD Tech Solutions",
      html: `
        <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:20px;">
          <div style="max-width:600px; margin:auto; background:#ffffff; padding:25px; border-radius:10px; box-shadow:0 2px 10px rgba(0,0,0,0.1);">
            <h2 style="color:#2c3e50; text-align:center;">SD Tech Solutions</h2>
            <p style="font-size:16px; color:#333;">Hello,</p>
            <p style="font-size:15px; color:#555;">
              Thank you for enrolling with <strong>SD Tech Solutions</strong>.
              Please use the OTP below to complete verification:
            </p>
            <div style="text-align:center; margin:30px 0;">
              <span style="display:inline-block; background:#007bff; color:#fff; font-size:28px; letter-spacing:5px; padding:12px 25px; border-radius:8px;">
                ${otp}
              </span>
            </div>
            <p style="font-size:14px; color:#555;">⏰ Valid for 5 minutes. Do not share this OTP.</p>
            <hr style="margin:25px 0; border:none; border-top:1px solid #eee;">
            <p style="font-size:13px; color:#999; text-align:center;">
              © ${new Date().getFullYear()} SD Tech Solutions
            </p>
          </div>
        </div>
      `,
    });

    console.log(`✅ OTP email sent successfully to: ${cleanEmail}`);

    // ✅ Send response to frontend
    return res.status(200).json({ 
      success: true, 
      message: "OTP sent successfully to your email" 
    });

  } catch (error) {
    console.error("❌ SEND OTP ERROR:", error.message);
    console.error("❌ Error Stack:", error.stack);
    
    return res.status(500).json({ 
      success: false, 
      message: "Failed to send OTP",
      error: error.message 
    });
  }
});

// ============================================================
// ✅ VERIFY OTP - FIXED
// ============================================================
app.post("/verify-otp", (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: "Email and OTP are required",
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const stored = otpStore[cleanEmail];

    console.log("🔍 Verifying OTP for:", cleanEmail);
    console.log("🔍 Stored OTP exists:", !!stored);
    console.log("🔍 Entered OTP:", otp);

    if (!stored) {
      return res.status(200).json({
        success: false,
        message: "OTP not found. Please request a new one.",
      });
    }

    if (Date.now() > stored.expiresAt) {
      delete otpStore[cleanEmail];
      return res.status(200).json({
        success: false,
        message: "OTP expired. Please request a new one.",
      });
    }

    if (stored.otp === String(otp).trim()) {
      delete otpStore[cleanEmail];
      console.log("✅ OTP verified successfully for:", cleanEmail);
      return res.status(200).json({ 
        success: true, 
        message: "OTP verified successfully" 
      });
    }

    console.log("❌ Invalid OTP entered for:", cleanEmail);
    return res.status(200).json({ 
      success: false, 
      message: "Invalid OTP. Please try again." 
    });

  } catch (error) {
    console.error("❌ VERIFY OTP ERROR:", error.message);
    return res.status(500).json({ 
      success: false, 
      message: "Verification failed",
      error: error.message 
    });
  }
});

// ============================================================
// ✅ SEND CREDENTIALS - FIXED
// ============================================================
app.post("/send-credentials", async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ 
        success: false, 
        message: "Email and password are required" 
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    await sendEmail({
      from: `"${COMPANY_NAME}" <${GMAIL_USER}>`,
      to: cleanEmail,
      subject: "Your Account Credentials - SD Tech Solutions",
      html: `
        <div style="font-family: Arial; padding: 20px; max-width:500px; margin:auto;">
          <h2 style="color:#6366f1;">Welcome to SD Tech Solutions 🎉</h2>
          <p>Hello <strong>${name || "Student"}</strong>,</p>
          <p>Your account has been approved by admin.</p>
          <div style="background:#f8fafc; padding:16px; border-radius:8px; margin:16px 0; border:1px solid #e2e8f0;">
            <p><b>Email:</b> ${cleanEmail}</p>
            <p><b>Password:</b> ${password}</p>
          </div>
          <p style="color:#ef4444;">⚠️ Please change your password after first login.</p>
          <br/>
          <p>Regards,<br/>SD Tech Team</p>
        </div>
      `,
    });

    console.log("✅ Credentials sent to:", cleanEmail);
    return res.status(200).json({ 
      success: true, 
      message: "Credentials sent successfully" 
    });

  } catch (error) {
    console.error("❌ SEND CREDENTIALS ERROR:", error.message);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to send credentials",
      error: error.message 
    });
  }
});

// ============================================================
// ✅ SEND CERTIFICATE - FIXED
// ============================================================
app.post("/send-certificate", async (req, res) => {
  let imageFile = null;
  let pdfFile = null;

  try {
    const { name, email, course, duration, date, certificateId } = req.body;

    if (!email || !name) {
      return res.status(400).json({
        success: false,
        message: "Name and email are required",
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    // Generate certificate image
    const width = 1200;
    const height = 850;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    const imagePath = path.join(__dirname, "certificate-template.png");

    if (!fs.existsSync(imagePath)) {
      return res.status(500).json({
        success: false,
        message: "Certificate template not found on server",
      });
    }

    const bg = await loadImage(imagePath);
    ctx.drawImage(bg, 0, 0, width, height);

    ctx.fillStyle = "#0f2f5f";
    ctx.textAlign = "center";

    ctx.font = "bold 50px Arial";
    ctx.fillText((name || "").toUpperCase(), width / 2, 420);

    ctx.font = "30px Arial";
    ctx.fillText(course || "", width / 2, 495);

    ctx.font = "20px Arial";
    ctx.fillText(`Duration: ${duration || ""}`, 250, 650);
    ctx.fillText(`Date: ${date || ""}`, 950, 650);

    const timestamp = Date.now();
    imageFile = path.join(__dirname, `certificate-${timestamp}.png`);
    pdfFile = path.join(__dirname, `certificate-${timestamp}.pdf`);

    const buffer = canvas.toBuffer("image/png");
    fs.writeFileSync(imageFile, buffer);

    // Generate PDF
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: "A4", layout: "landscape" });
      const stream = fs.createWriteStream(pdfFile);
      doc.pipe(stream);
      doc.image(imageFile, 0, 0, { width: 842 });
      doc.end();
      stream.on("finish", resolve);
      stream.on("error", reject);
    });

    // Send email with certificate
    await sendEmail({
      from: `"${COMPANY_NAME}" <${GMAIL_USER}>`,
      to: cleanEmail,
      subject: "🎓 Your Certificate - SD Tech Solutions",
      html: `
        <div style="font-family: Arial; padding: 20px; max-width:500px; margin:auto;">
          <h2 style="color:#6366f1;">Congratulations! 🎉</h2>
          <p>Hello <strong>${name}</strong>,</p>
          <p>You have successfully completed <strong>${course || ""}</strong>!</p>
          <div style="background:#f0fdf4; padding:16px; border-radius:8px; margin:16px 0; border:1px solid #86efac;">
            <p><strong>Certificate ID:</strong> ${certificateId || "N/A"}</p>
            <p><strong>Date:</strong> ${date || new Date().toLocaleDateString("en-IN")}</p>
          </div>
          <p>📎 Please find your certificate attached as PDF.</p>
          <p>Keep learning! 🚀</p>
          <br/>
          <p>- SD Tech Solutions Team</p>
        </div>
      `,
      attachments: [
        {
          filename: `Certificate_${name.replace(/\s+/g, "_")}.pdf`,
          path: pdfFile,
        },
      ],
    });

    console.log("✅ Certificate sent to:", cleanEmail);
    return res.status(200).json({ 
      success: true, 
      message: "Certificate sent successfully" 
    });

  } catch (error) {
    console.error("❌ SEND CERTIFICATE ERROR:", error.message);
    console.error("❌ Stack:", error.stack);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to send certificate",
      error: error.message 
    });
  } finally {
    // Cleanup temp files
    setTimeout(() => {
      try {
        if (imageFile && fs.existsSync(imageFile)) fs.unlinkSync(imageFile);
        if (pdfFile && fs.existsSync(pdfFile)) fs.unlinkSync(pdfFile);
      } catch (e) {
        console.log("⚠️ Cleanup error:", e.message);
      }
    }, 5000);
  }
});

// ============================================================
// ✅ GENERATE CERTIFICATE (returns image buffer)
// ============================================================
app.post("/generate-certificate", async (req, res) => {
  try {
    const { name, course, duration, date, certificateId } = req.body;

    const width = 1200;
    const height = 850;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");

    const imagePath = path.join(__dirname, "certificate-template.png");
    
    if (!fs.existsSync(imagePath)) {
      return res.status(500).json({
        success: false,
        message: "Certificate template not found",
      });
    }

    const bg = await loadImage(imagePath);
    ctx.drawImage(bg, 0, 0, width, height);

    ctx.fillStyle = "#0f2f5f";
    ctx.textAlign = "center";

    ctx.font = "bold 50px Arial";
    ctx.fillText((name || "").toUpperCase(), width / 2, 420);

    ctx.font = "30px Arial";
    ctx.fillText(course || "", width / 2, 495);

    ctx.font = "20px Arial";
    ctx.fillText(`Duration: ${duration || ""}`, 250, 650);
    ctx.fillText(`Date: ${date || ""}`, 950, 650);

    const buffer = canvas.toBuffer("image/png");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Content-Disposition", `inline; filename="certificate_${name}.png"`);
    return res.status(200).send(buffer);

  } catch (error) {
    console.error("❌ GENERATE CERTIFICATE ERROR:", error.message);
    return res.status(500).json({ 
      success: false, 
      message: "Failed to generate certificate",
      error: error.message 
    });
  }
});

// ============================================================
// ✅ APPROVE USER - FIXED
// ============================================================
app.post("/approve-user", async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("📝 APPROVE USER REQUEST RECEIVED");
    console.log("Raw Email:", email);
    console.log("Password Length:", password?.length);

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanPassword = String(password).trim();

    // Validate password length
    if (cleanPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    console.log("🧹 Cleaned Email:", cleanEmail);
    console.log("🔐 STEP 1: Creating Firebase Auth Account...");

    let authSuccess = false;
    let userUID = null;

    try {
      const userRecord = await admin.auth().createUser({
        email: cleanEmail,
        password: cleanPassword,
        emailVerified: false,
      });

      userUID = userRecord.uid;
      authSuccess = true;

      console.log("✅ Firebase Auth user created!");
      console.log("   UID:", userRecord.uid);
    } catch (error) {
      if (error.code === "auth/email-already-exists") {
        console.log("⚠️ User already exists, updating password...");

        try {
          const existingUser = await admin.auth().getUserByEmail(cleanEmail);
          await admin.auth().updateUser(existingUser.uid, {
            password: cleanPassword,
          });

          userUID = existingUser.uid;
          authSuccess = true;
          console.log("✅ Password updated for existing user!");
        } catch (updateErr) {
          console.error("❌ Failed to update password:", updateErr.message);
          throw updateErr;
        }
      } else if (error.code === "auth/invalid-password") {
        throw new Error("Password must be at least 6 characters long");
      } else if (error.code === "auth/invalid-email") {
        throw new Error("Invalid email format");
      } else {
        console.error("❌ Firebase Auth Error:", error.code, error.message);
        throw error;
      }
    }

    if (!authSuccess) {
      throw new Error("Failed to create/update Firebase Auth account");
    }

    // Update Firestore enrollment
    console.log("📄 STEP 2: Updating Firestore Enrollment...");

    const snapshot = await db
      .collection("enrollments")
      .where("email", "==", cleanEmail)
      .get();

    if (snapshot.empty) {
      console.log("⚠️ No enrollment found for:", cleanEmail);
    } else {
      const enrollDoc = snapshot.docs[0];
      await db.collection("enrollments").doc(enrollDoc.id).update({
        status: "approved",
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: "admin",
      });
      console.log("✅ Enrollment updated to 'approved'");
    }

    // Send credentials email
    console.log("📧 STEP 3: Sending credentials email...");

    const emailHTML = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
          <h1 style="color: white; margin: 0;">🎉 Account Approved!</h1>
        </div>
        <div style="background: white; padding: 30px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
          <p style="font-size: 16px; color: #334155;">Dear Student,</p>
          <p style="font-size: 15px; color: #64748b; line-height: 1.6;">
            Your account has been <strong style="color: #16a34a;">approved successfully</strong>!
          </p>
          <div style="background: #f8fafc; border-left: 4px solid #6366f1; padding: 20px; margin: 20px 0; border-radius: 8px;">
            <p style="margin: 0 0 10px 0; font-weight: 600; color: #1e293b;">📋 Your Login Credentials:</p>
            <p style="margin: 5px 0; color: #475569;"><strong>Email:</strong> ${cleanEmail}</p>
            <p style="margin: 5px 0; color: #475569;"><strong>Password:</strong> 
              <code style="background: #e2e8f0; padding: 4px 8px; border-radius: 4px; font-family: monospace;">${cleanPassword}</code>
            </p>
          </div>
          <div style="background: #fef3c7; border: 1px solid #f59e0b; padding: 16px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; color: #92400e; font-size: 14px;">⚠️ <strong>Important:</strong></p>
            <ul style="margin: 10px 0 0 0; padding-left: 20px; color: #92400e; font-size: 13px;">
              <li>Copy the password exactly as shown</li>
              <li>Do NOT add any extra spaces</li>
              <li>Change your password after first login</li>
            </ul>
          </div>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${FRONTEND_URL}/login"
               style="display: inline-block; background: linear-gradient(135deg, #6366f1, #8b5cf6);
                      color: white; padding: 14px 32px; text-decoration: none; border-radius: 8px;
                      font-weight: 600; font-size: 16px;">
              🚀 Login to Dashboard
            </a>
          </div>
        </div>
        <div style="text-align: center; padding: 20px; color: #cbd5e1; font-size: 12px;">
          © ${new Date().getFullYear()} SD Tech Solutions. All rights reserved.
        </div>
      </div>
    `;

    await sendEmail({
      from: `"${COMPANY_NAME}" <${GMAIL_USER}>`,
      to: cleanEmail,
      subject: "✅ Your Account is Approved - SD Tech Solutions",
      html: emailHTML,
    });

    console.log("✅ Credentials email sent to:", cleanEmail);
    console.log("🎉 APPROVAL PROCESS COMPLETED");

    return res.status(200).json({
      success: true,
      message: "User approved successfully",
      data: {
        email: cleanEmail,
        uid: userUID,
        timestamp: new Date().toISOString(),
      },
    });

  } catch (error) {
    console.error("❌ APPROVE USER ERROR:", error.message);
    console.error("❌ Error Code:", error.code);
    console.error("❌ Stack:", error.stack);

    return res.status(500).json({
      success: false,
      message: error.message || "Failed to approve user",
      code: error.code || "unknown",
    });
  }
});

// ============================================================
// ✅ TEST LOGIN
// ============================================================
app.post("/test-login", async (req, res) => {
  try {
    const { email, password } = req.body;

    console.log("🧪 TEST LOGIN REQUEST");
    console.log("Email:", email);

    const cleanEmail = String(email).trim().toLowerCase();

    try {
      const user = await admin.auth().getUserByEmail(cleanEmail);
      console.log("✅ User exists in Firebase Auth, UID:", user.uid);

      return res.status(200).json({
        success: true,
        message: "User exists in Firebase Auth",
        user: {
          uid: user.uid,
          email: user.email,
          emailVerified: user.emailVerified,
          disabled: user.disabled,
        },
      });
    } catch (error) {
      if (error.code === "auth/user-not-found") {
        console.log("❌ User NOT found in Firebase Auth");
        return res.status(200).json({
          success: false,
          message: "User not found. Please approve user first.",
          code: "user-not-found",
        });
      }
      throw error;
    }

  } catch (error) {
    console.error("❌ TEST LOGIN ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
});

// ============================================================
// ✅ PASSWORD RESET
// ============================================================
app.post("/send-password-reset", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    console.log("🔄 Generating password reset link for:", cleanEmail);

    const resetLink = await admin.auth().generatePasswordResetLink(cleanEmail);

    await sendEmail({
      from: `"${COMPANY_NAME}" <${GMAIL_USER}>`,
      to: cleanEmail,
      subject: "🔐 Reset Your Password - SD Tech Solutions",
      html: `
        <div style="font-family: Arial; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #6366f1;">Reset Your Password</h2>
          <p>Hello,</p>
          <p>Click the button below to reset your password:</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetLink}"
               style="display: inline-block; background: #6366f1; color: white;
                      padding: 14px 32px; text-decoration: none; border-radius: 8px;
                      font-weight: 600;">
              Reset Password
            </a>
          </div>
          <p style="color: #64748b; font-size: 13px;">
            This link expires in 1 hour. If you didn't request this, please ignore this email.
          </p>
          <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
          <p style="font-size: 12px; color: #94a3b8; text-align: center;">
            © ${new Date().getFullYear()} SD Tech Solutions
          </p>
        </div>
      `,
    });

    console.log("✅ Password reset email sent to:", cleanEmail);

    return res.status(200).json({
      success: true,
      message: "Password reset link sent successfully",
    });

  } catch (error) {
    console.error("❌ PASSWORD RESET ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
});

// ============================================================
// ✅ CHECK USER
// ============================================================
app.post("/check-user", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: "Email is required" 
      });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    
    const snapshot = await admin
      .firestore()
      .collection("enrollments")
      .where("email", "==", cleanEmail)
      .get();

    return res.status(200).json({ 
      success: true,
      exists: !snapshot.empty 
    });

  } catch (error) {
    console.error("❌ CHECK USER ERROR:", error.message);
    return res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// ============================================================
// ✅ UPLOAD LESSONS
// ============================================================
function cleanData(obj) {
  if (Array.isArray(obj)) return obj.map(cleanData);
  if (obj !== null && typeof obj === "object") {
    const newObj = {};
    for (let key in obj) {
      if (key.startsWith("__") || key === "constructor" || key === "prototype")
        continue;
      newObj[key] = cleanData(obj[key]);
    }
    return newObj;
  }
  return obj;
}

app.get("/upload-lessons", async (req, res) => {
  try {
    const filePath = path.join(__dirname, "course.json");
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        success: false,
        message: "course.json not found on server",
      });
    }

    const data = fs.readFileSync(filePath, "utf-8");
    const parsedData = JSON.parse(data);
    const lessons = parsedData.lessons;

    if (!Array.isArray(lessons)) {
      return res.status(400).json({
        success: false,
        message: "Lessons array not found in course.json",
      });
    }

    const batch = db.batch();
    lessons.forEach((lesson, index) => {
      const id = lesson.lessonId || `lesson_${index}`;
      const cleanLesson = cleanData(lesson);
      const docRef = db.collection("lessons").doc(id);
      batch.set(docRef, cleanLesson);
    });

    await batch.commit();

    return res.status(200).json({
      success: true,
      message: "Lessons uploaded successfully",
      count: lessons.length,
    });

  } catch (error) {
    console.error("❌ UPLOAD LESSONS ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "Upload failed",
      error: error.message,
    });
  }
});

// ============================================================
// ✅ PDF INVOICE GENERATOR
// ============================================================
function generateInvoicePDF(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: "A4",
        margin: 50,
        bufferPages: true,
      });

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const primaryColor = "#6366f1";
      const darkColor = "#1e293b";
      const mutedColor = "#64748b";
      const greenColor = "#16a34a";
      const redColor = "#ef4444";

      // Header
      doc.rect(0, 0, doc.page.width, 120).fill(primaryColor);
      doc.fillColor("#ffffff").fontSize(24).font("Helvetica-Bold").text("SD TECH SOLUTIONS", 50, 40);
      doc.fontSize(10).font("Helvetica").text(GMAIL_USER, 50, 70).text("Payment Receipt / Invoice", 50, 85);
      doc.fontSize(22).font("Helvetica-Bold").text("INVOICE", 400, 50, { align: "right" });
      doc.fontSize(10).font("Helvetica").fillColor("#f8fafc")
        .text(`No: ${data.invoiceNo}`, 400, 80, { align: "right" })
        .text(`Date: ${data.date}`, 400, 95, { align: "right" });

      let y = 150;

      // Bill To
      doc.roundedRect(50, y, 240, 100, 5).fillAndStroke("#f8fafc", "#e2e8f0");
      doc.fillColor(mutedColor).fontSize(9).font("Helvetica-Bold").text("BILL TO", 60, y + 10);
      doc.fillColor(darkColor).fontSize(12).font("Helvetica-Bold").text(data.name, 60, y + 28);
      doc.fontSize(10).font("Helvetica").fillColor(mutedColor).text(data.email, 60, y + 48);
      if (data.phone) doc.text(data.phone, 60, y + 65);

      // Payment Details
      doc.roundedRect(310, y, 240, 100, 5).fillAndStroke("#f8fafc", "#e2e8f0");
      doc.fillColor(mutedColor).fontSize(9).font("Helvetica-Bold").text("PAYMENT DETAILS", 320, y + 10);
      doc.fillColor(darkColor).fontSize(10).font("Helvetica")
        .text(`Course: ${data.course}`, 320, y + 28)
        .text(`Mode: ${(data.mode || "cash").toUpperCase()}`, 320, y + 48)
        .text(`Date: ${data.date}`, 320, y + 68);

      y += 130;

      // Table Header
      doc.rect(50, y, 500, 30).fill(darkColor);
      doc.fillColor("#ffffff").fontSize(10).font("Helvetica-Bold")
        .text("ITEM DESCRIPTION", 60, y + 10)
        .text("AMOUNT", 450, y + 10, { align: "right" });

      y += 30;
      doc.rect(50, y, 500, 1).fill("#e2e8f0");

      // Item
      doc.fillColor(darkColor).fontSize(10).font("Helvetica")
        .text(`Installment Payment (${data.course})`, 60, y + 15);
      doc.font("Helvetica-Bold")
        .text(`${Number(data.amount || 0).toLocaleString("en-IN")}`, 450, y + 15, { align: "right" });

      y += 50;

      // Summary
      const summaryX = 310;
      const summaryWidth = 240;
      doc.roundedRect(summaryX, y, summaryWidth, 110, 5).fillAndStroke("#ffffff", "#e2e8f0");

      doc.fillColor(mutedColor).fontSize(10).font("Helvetica").text("Total Fee", summaryX + 15, y + 15);
      doc.fillColor(darkColor).font("Helvetica-Bold")
        .text(`${Number(data.totalFee || 0).toLocaleString("en-IN")}`, summaryX + summaryWidth - 75, y + 15, { align: "right" });

      y += 30;
      doc.fillColor(mutedColor).font("Helvetica").text("Paid Till Now", summaryX + 15, y);
      doc.fillColor(greenColor).font("Helvetica-Bold")
        .text(`${Number(data.paid || 0).toLocaleString("en-IN")}`, summaryX + summaryWidth - 75, y, { align: "right" });

      y += 30;
      doc.fillColor(mutedColor).font("Helvetica").text("Balance", summaryX + 15, y);
      doc.fillColor(redColor).font("Helvetica-Bold").fontSize(12)
        .text(`${Number(data.balance || 0).toLocaleString("en-IN")}`, summaryX + summaryWidth - 75, y, { align: "right" });

      // Remark
      if (data.remark) {
        y += 60;
        doc.roundedRect(50, y, 500, 60, 5).fillAndStroke("#fef3c7", "#f59e0b");
        doc.fillColor("#92400e").fontSize(10).font("Helvetica-Bold").text("Remark:", 60, y + 15);
        doc.font("Helvetica").text(data.remark, 60, y + 32, { width: 480 });
      }

      // Footer
      const footerY = doc.page.height - 60;
      doc.fontSize(8).fillColor(mutedColor).font("Helvetica")
        .text("System generated invoice • SD Tech Solutions", 50, footerY, { align: "center", width: 500 });

      doc.end();

    } catch (error) {
      reject(error);
    }
  });
}

// ============================================================
// ✅ SEND INVOICE
// ============================================================
app.post("/send-invoice", async (req, res) => {
  try {
    const d = req.body || {};

    console.log("📧 Invoice Request:", {
      email: d.email,
      name: d.name,
      amount: d.amount,
    });

    if (!d.email) return res.status(400).json({ success: false, message: "Email is required" });
    if (!d.name) return res.status(400).json({ success: false, message: "Name is required" });
    if (!d.course) return res.status(400).json({ success: false, message: "Course is required" });

    const invoiceNo = d.invoiceNo || `INV-${Date.now()}`;
    const cleanEmail = String(d.email).trim().toLowerCase();

    const invoiceData = {
      invoiceNo,
      name: d.name,
      email: cleanEmail,
      phone: d.phone || "",
      course: d.course,
      amount: Number(d.amount || 0),
      totalFee: Number(d.totalFee || 0),
      paid: Number(d.paid || 0),
      balance: Number(d.balance || 0),
      date: d.date || new Date().toISOString().slice(0, 10),
      mode: d.mode || "cash",
      remark: d.remark || "",
    };

    console.log("📄 Generating PDF Invoice...");
    const pdfBuffer = await generateInvoicePDF(invoiceData);
    console.log("✅ PDF Generated, size:", pdfBuffer.length, "bytes");

    await sendEmail({
      from: `"${COMPANY_NAME}" <${GMAIL_USER}>`,
      to: cleanEmail,
      subject: `Payment Invoice ${invoiceNo} - ${d.course}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f8fafc;">
          <div style="background: white; border-radius: 12px; padding: 30px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
            <h2 style="color: #6366f1; margin: 0 0 10px 0;">Payment Received ✅</h2>
            <p style="color: #64748b; margin: 0 0 20px 0;">Dear <strong style="color: #1e293b;">${d.name}</strong>,</p>
            <p style="color: #334155; line-height: 1.6;">
              We have received your payment of
              <strong style="color: #16a34a;">₹${Number(d.amount || 0).toLocaleString("en-IN")}</strong>
              for <strong>${d.course}</strong>.
            </p>
            <div style="background: #f8fafc; border-left: 4px solid #6366f1; border-radius: 8px; padding: 16px; margin: 20px 0;">
              <p style="margin: 4px 0; color: #475569;"><strong>Invoice No:</strong> ${invoiceNo}</p>
              <p style="margin: 4px 0; color: #475569;"><strong>Date:</strong> ${d.date || new Date().toLocaleDateString("en-IN")}</p>
              <p style="margin: 4px 0; color: #475569;"><strong>Total Paid:</strong> <span style="color: #16a34a;">₹${Number(d.paid || 0).toLocaleString("en-IN")}</span></p>
              <p style="margin: 4px 0; color: #475569;"><strong>Balance:</strong> <span style="color: #ef4444;">₹${Number(d.balance || 0).toLocaleString("en-IN")}</span></p>
            </div>
            <p style="color: #64748b; font-size: 14px;">📎 Please find your invoice attached.</p>
            <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;">
            <p style="font-size: 13px; color: #94a3b8; margin: 0;">
              Contact: <a href="mailto:${GMAIL_USER}" style="color: #6366f1;">${GMAIL_USER}</a>
            </p>
          </div>
        </div>
      `,
      attachments: [
        {
          filename: `Invoice_${invoiceNo}.pdf`,
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    console.log("✅ Invoice email sent successfully!");

    return res.status(200).json({
      success: true,
      message: "Invoice sent successfully",
      invoiceNo,
    });

  } catch (err) {
    console.error("❌ INVOICE ERROR:", err.message);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to send invoice",
    });
  }
});

// ============================================================
// ✅ SEND SINGLE EMAIL
// ============================================================
app.post("/send-email", async (req, res) => {
  try {
    const { to_email, to_name, subject, message } = req.body;

    if (!to_email || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: "to_email, subject, and message are required.",
      });
    }

    const cleanEmail = String(to_email).trim().toLowerCase();

    await sendEmail({
      from: `"${COMPANY_NAME}" <${GMAIL_USER}>`,
      to: cleanEmail,
      subject: subject,
      html: getBlastHTML(to_name || "Student", message),
    });

    console.log(`✅ Email sent to ${cleanEmail}`);
    return res.status(200).json({ 
      success: true, 
      message: "Email sent successfully" 
    });

  } catch (err) {
    console.error("❌ SEND EMAIL ERROR:", err.message);
    return res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// ============================================================
// ✅ SEND BULK EMAILS
// ============================================================
app.post("/send-bulk-email", async (req, res) => {
  try {
    const { targets, subject, message } = req.body;

    if (!targets || !targets.length || !subject || !message) {
      return res.status(400).json({
        success: false,
        message: "targets, subject, and message are required.",
      });
    }

    console.log(`📧 Starting bulk email: ${targets.length} contacts...`);

    let sent = 0;
    let failed = 0;
    const errors = [];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];

      try {
        const pMsg = message
          .replace(/\{\{name\}\}/g, target.name || "Student")
          .replace(/\{\{email\}\}/g, target.email || "");

        const pSubject = subject.replace(/\{\{name\}\}/g, target.name || "Student");

        await sendEmail({
          from: `"${COMPANY_NAME}" <${GMAIL_USER}>`,
          to: target.email,
          subject: pSubject,
          html: getBlastHTML(target.name || "Student", pMsg),
        });

        sent++;
        console.log(`✅ [${i + 1}/${targets.length}] ${target.email}`);

      } catch (err) {
        failed++;
        errors.push({ email: target.email, error: err.message });
        console.log(`❌ [${i + 1}/${targets.length}] ${target.email} - ${err.message}`);
      }

      // Rate limit: wait 1 second between emails
      if (i < targets.length - 1) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    console.log(`📧 Done! Sent: ${sent}, Failed: ${failed}`);

    return res.status(200).json({
      success: true,
      message: `Bulk email completed: ${sent} sent, ${failed} failed`,
      sent,
      failed,
      total: targets.length,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (err) {
    console.error("❌ BULK EMAIL ERROR:", err.message);
    return res.status(500).json({ 
      success: false, 
      message: err.message 
    });
  }
});

// ============================================================
// Email Blast HTML Template
// ============================================================
function getBlastHTML(name, message) {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:'Segoe UI',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb;padding:24px 10px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
<tr><td style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:28px 24px;border-radius:16px 16px 0 0;text-align:center;">
<h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;">${COMPANY_NAME}</h1>
</td></tr>
<tr><td style="background:#ffffff;padding:28px 24px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb;">
<p style="font-size:16px;color:#334155;margin:0 0 16px;">Hello <strong style="color:#0f172a;">${name}</strong>,</p>
<div style="font-size:15px;color:#475569;line-height:1.8;white-space:pre-wrap;">${message}</div>
</td></tr>
<tr><td style="background:#f8fafc;padding:16px 24px;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;text-align:center;">
<p style="font-size:12px;color:#94a3b8;margin:0;">© ${new Date().getFullYear()} ${COMPANY_NAME}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ============================================================
// ✅ AUTO SCHEDULED EMAILS CRON
// ============================================================
cron.schedule("0 8 * * *", async () => {
  console.log("⏰ Running Scheduled Email Cron Job...");
  try {
    const today = new Date().toISOString().split("T")[0];

    const inquiriesRef = db.collection("inquiries");
    const snapshot = await inquiriesRef
      .where("scheduledEmail.status", "==", "pending")
      .get();

    if (snapshot.empty) {
      console.log("🤷 No pending scheduled emails for today.");
      return;
    }

    let sentCount = 0;

    for (let docSnap of snapshot.docs) {
      const inquiry = docSnap.data();
      const scheduledData = inquiry.scheduledEmail;
      const email = inquiry.email;

      if (email && scheduledData.message && scheduledData.date <= today) {
        try {
          await sendEmail({
            from: `"${COMPANY_NAME}" <${GMAIL_USER}>`,
            to: email,
            subject: "Follow-up from SD Tech Solutions",
            html: `
              <div style="font-family: Arial, sans-serif; background: #f8fafc; padding: 20px;">
                <div style="max-width: 600px; margin: auto; background: white; padding: 30px; border-radius: 10px; border: 1px solid #e2e8f0;">
                  <h2 style="color: #6366f1; margin-top: 0;">Hello ${inquiry.name || "there"},</h2>
                  <p style="white-space: pre-wrap; font-size: 15px; color: #334155; line-height: 1.6;">${scheduledData.message}</p>
                  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 30px 0 20px 0;">
                  <p style="color: #64748b; font-size: 14px; margin: 0;">Regards,</p>
                  <strong style="color: #1e293b;">${COMPANY_NAME} Team</strong>
                </div>
              </div>
            `,
          });

          await inquiriesRef.doc(docSnap.id).update({
            "scheduledEmail.status": "sent",
            "scheduledEmail.sentAt": new Date().toISOString(),
          });

          console.log(`✅ Scheduled email sent to: ${email}`);
          sentCount++;
        } catch (err) {
          console.error(`❌ Failed scheduled email to ${email}:`, err.message);
        }
      }
    }
    console.log(`📧 Cron Finished. Sent ${sentCount} scheduled emails.`);
  } catch (error) {
    console.error("❌ Cron Job Error:", error.message);
  }
});

// ============================================================
// ✅ DOWNLOAD BACKUP
// ============================================================
app.get("/download-backup", async (req, res) => {
  try {
    console.log("📦 Backup process started...");
    const backupData = {};

    const collections = await db.listCollections();

    for (let collection of collections) {
      const collectionName = collection.id;
      const snapshot = await db.collection(collectionName).get();

      backupData[collectionName] = [];

      snapshot.forEach((doc) => {
        let docData = doc.data();

        for (let key in docData) {
          if (docData[key] && typeof docData[key].toDate === "function") {
            docData[key] = docData[key].toDate().toISOString();
          }
        }

        backupData[collectionName].push({
          id: doc.id,
          ...docData,
        });
      });
    }

    const date = new Date().toISOString().split("T")[0];
    const fileName = `SD_Tech_Backup_${date}.json`;

    res.setHeader("Content-Disposition", `attachment; filename=${fileName}`);
    res.setHeader("Content-Type", "application/json");
    return res.status(200).send(JSON.stringify(backupData, null, 2));

  } catch (error) {
    console.error("❌ BACKUP ERROR:", error.message);
    return res.status(500).json({
      success: false,
      message: "Backup generation failed",
      error: error.message,
    });
  }
});

// ============================================================
// ✅ RESTORE BACKUP
// ============================================================
app.post("/restore-backup", async (req, res) => {
  try {
    const backupData = req.body;

    if (!backupData || typeof backupData !== "object") {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid backup data format." 
      });
    }

    console.log("⬆️ Restore process started (Missing Data Only)...");

    let totalRestored = 0;
    let skippedExisting = 0;
    let skippedInvalid = 0;

    for (const [collectionName, documents] of Object.entries(backupData)) {
      if (!Array.isArray(documents) || documents.length === 0) continue;
      if (!collectionName || typeof collectionName !== "string" || collectionName.trim() === "") continue;

      console.log(`📂 Collection: [${collectionName}] (${documents.length} docs)`);

      const validDocs = documents.filter(
        (docData) => docData && typeof docData.id === "string" && docData.id.trim() !== ""
      );

      skippedInvalid += documents.length - validDocs.length;
      if (validDocs.length === 0) continue;

      for (let i = 0; i < validDocs.length; i += 100) {
        const chunk = validDocs.slice(i, i + 100);
        const batch = db.batch();

        const docRefs = chunk.map((docData) =>
          db.collection(collectionName).doc(docData.id)
        );
        const existingDocs = await db.getAll(...docRefs);

        let addedInThisBatch = false;

        chunk.forEach((docData, index) => {
          const { id, ...data } = docData;

          if (!existingDocs[index].exists) {
            console.log(`   ➕ Restoring: ${id}`);
            batch.set(docRefs[index], data);
            totalRestored++;
            addedInThisBatch = true;
          } else {
            skippedExisting++;
          }
        });

        if (addedInThisBatch) {
          await batch.commit();
          console.log(`   💾 Batch committed.`);
        }
      }
    }

    console.log(`🎉 Restored: ${totalRestored} | Skipped: ${skippedExisting} | Invalid: ${skippedInvalid}`);

    return res.status(200).json({
      success: true,
      message: `Restored ${totalRestored} documents! (Skipped ${skippedExisting} existing, ${skippedInvalid} invalid)`,
    });

  } catch (error) {
    console.error("❌ RESTORE ERROR:", error.message);
    return res.status(500).json({ 
      success: false, 
      message: "Restore failed", 
      error: error.message 
    });
  }
});

// ============================================================
// ✅ GLOBAL ERROR HANDLER
// ============================================================
app.use((err, req, res, next) => {
  console.error("🔥 UNHANDLED ERROR:", err.message);
  console.error("🔥 Stack:", err.stack);
  
  return res.status(500).json({
    success: false,
    message: "Internal server error",
    error: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// Handle 404
app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.url} not found`,
  });
});

// ============================================================
// ✅ SERVER START
// ============================================================
app.listen(PORT, () => {
  console.log("═══════════════════════════════════════════");
  console.log(`🚀 ${COMPANY_NAME} Server Started`);
  console.log(`📡 Port:        ${PORT}`);
  console.log(`📧 Gmail:       ${GMAIL_USER}`);
  console.log(`🔗 Server URL:  ${SERVER_URL}`);
  console.log(`🖥️  Frontend:    ${FRONTEND_URL}`);
  console.log(`🏓 Keep-Alive:  ${SERVER_URL}/health`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log("═══════════════════════════════════════════");

  // Initial ping after 5 seconds
  setTimeout(() => {
    selfPing();
  }, 5000);
});

process.on("SIGINT", () => {
  console.log("\n🛑 Server stopped (SIGINT)");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Server terminated (SIGTERM)");
  process.exit(0);
});

// Catch unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("❌ Uncaught Exception:", error.message);
  console.error("❌ Stack:", error.stack);
});