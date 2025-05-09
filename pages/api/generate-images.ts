import type { NextApiRequest, NextApiResponse } from "next";
import { GoogleGenAI } from "@google/genai";
import * as fs from "node:fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import sharp from "sharp";
import formidable from "formidable";
import mime from "mime";
import { PrismaClient } from '@prisma/client';
import { verifyToken } from '../../lib/auth';

const prisma = new PrismaClient();

// Danh sách phong cách hợp lệ
const validStyles = ["cinematic", "anime", "flat lay", "realistic"];

// Interface cho body của request JSON
interface RequestBody {
  prompt?: string;
  segmentIdx?: string | number;
  styleSettings?: { style: string; character: string; scene: string };
  image_base64?: string;
  image_description?: string;
  // Các tham số cũ (không còn sử dụng nhưng vẫn giữ để tương thích ngược)
  height?: number;
  width?: number;
  seed?: number;
  model_id?: string; // Bỏ qua tham số này, luôn sử dụng Gemini 2.0 Flash
}

// Hàm tạo ảnh sử dụng Gemini 2.0 Flash theo đúng cấu trúc của Google
async function generateImageWithGemini(prompt: string, apiKey: string, retries = 3) {
  // Khởi tạo Google GenAI với API key
  const ai = new GoogleGenAI({
    apiKey: apiKey,
  });
  
  // Cấu hình chính xác như trong ví dụ
  const config = {
    responseModalities: [
      'image',
      'text',
    ],
    responseMimeType: 'text/plain',
    temperature: 1.0,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
  };
  
  // Sử dụng đúng model như trong ví dụ
  const model = 'gemini-2.0-flash-exp-image-generation'; // Tên model chính xác
  
  // Thử lại nếu có lỗi
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`Attempt ${attempt}: Generating image with prompt: ${prompt}`);
      
      // Cấu trúc nội dung đúng như ví dụ
      const contents = [
        {
          role: 'user',
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ];
      
      // Sử dụng generateContentStream như trong ví dụ
      const response = await ai.models.generateContentStream({
        model,
        config,
        contents,
      });
      
      // Xử lý từng chunk của stream
      for await (const chunk of response) {
        if (!chunk.candidates || !chunk.candidates[0].content || !chunk.candidates[0].content.parts) {
          continue;
        }
        
        // Kiểm tra nếu chunk chứa dữ liệu ảnh
        if (chunk.candidates[0].content.parts[0].inlineData) {
          const inlineData = chunk.candidates[0].content.parts[0].inlineData;
          if (inlineData.mimeType?.startsWith('image/') && inlineData.data) {
            console.log('Image data received successfully');
            return inlineData;
          }
        } else if (chunk.text) {
          // Log text response nếu có
          console.log('Text response:', chunk.text);
        }
      }
      
      // Nếu không tìm thấy dữ liệu ảnh trong response
      console.error('No image data found in the response');
      if (attempt < retries) {
        console.log(`Retrying in ${1000 * attempt}ms...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
    } catch (error: any) {
      console.error(`Error in attempt ${attempt}:`, error.message || error);
      if (attempt < retries) {
        console.log(`Retrying in ${1000 * attempt}ms...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      } else {
        throw new Error(`Failed to generate image after ${retries} attempts: ${error.message}`);
      }
    }
  }
  
  return null;
}

// Main API handler

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ success: false, error: `Method ${req.method} Not Allowed` });
  }

  try {
    const contentType = req.headers["content-type"] || "";
    let index: number | undefined;
    let prompt: string | undefined;
    let file: any;
    let styleSettings: { style: string; character: string; scene: string } | undefined;
    const apiKey = process.env.GEMINI_API_KEY;

    // Require authentication for all user-generated images
    const user = await verifyToken(req, prisma);
    if (!user) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    // Handle JSON or multipart/form-data requests
    let imageDescription: string | undefined = undefined;
    if (contentType.includes("application/json")) {
      const body: RequestBody = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error("Invalid JSON format"));
          }
        });
      });
      if (typeof body.prompt === "string") {
        prompt = body.prompt;
      }
      if (typeof body.segmentIdx !== "undefined") {
        index = parseInt(String(body.segmentIdx), 10);
      }
      if (body.styleSettings && typeof body.styleSettings === "object") {
        styleSettings = body.styleSettings;
      }
      if (typeof body.image_base64 === "string" && body.image_base64.startsWith("data:image")) {
        file = { base64: body.image_base64 };
      }
      if (typeof body.image_description === "string") {
        imageDescription = body.image_description;
      }
    } else if (contentType.includes("multipart/form-data")) {
      const form = formidable({ multiples: false, maxFileSize: 5 * 1024 * 1024 });
      const formData = await new Promise<{ fields: formidable.Fields; files: formidable.Files }>((resolve, reject) => {
        form.parse(req as any, (err, fields, files) => {
          if (err) {
            console.error("Formidable parse error:", err);
            reject(new Error("Failed to parse form data"));
          } else {
            resolve({ fields, files });
          }
        });
      });
      index = parseInt(
        Array.isArray(formData.fields.index) ? formData.fields.index[0] : formData.fields.index || "0",
        10
      );
      prompt = Array.isArray(formData.fields.prompt) ? formData.fields.prompt[0] : formData.fields.prompt;
      if (typeof prompt !== "string") {
        return res.status(400).json({ success: false, error: "Prompt must be a string" });
      }
      styleSettings = formData.fields.styleSettings
        ? JSON.parse(
            Array.isArray(formData.fields.styleSettings)
              ? formData.fields.styleSettings[0]
              : formData.fields.styleSettings
          )
        : undefined;
      if (formData.fields.image_description) {
        imageDescription = Array.isArray(formData.fields.image_description)
          ? formData.fields.image_description[0]
          : formData.fields.image_description;
      }
      file = formData.files.file;
      const imageBase64 = Array.isArray(formData.fields.image_base64)
        ? formData.fields.image_base64[0]
        : formData.fields.image_base64;
      if (typeof imageBase64 === "string" && imageBase64.startsWith("data:image")) {
        file = { base64: imageBase64 };
      }
    } else {
      return res.status(400).json({ success: false, error: "Unsupported content type" });
    }

    // Validate inputs
    if (!apiKey && !file) {
      return res.status(500).json({ success: false, error: "Missing GEMINI_API_KEY or file" });
    }
    if (typeof index !== "number" || isNaN(index)) {
      return res.status(400).json({ success: false, error: "Invalid segment index" });
    }
    // Cho phép tạo ảnh AI mà không cần styleSettings, chỉ cần image_description
    // if (prompt && !styleSettings) {
    //   return res.status(400).json({ success: false, error: "Missing styleSettings for AI-generated image" });
    // }
    if (styleSettings && !validStyles.includes(styleSettings.style)) {
      return res.status(400).json({ success: false, error: `Invalid style: ${styleSettings.style}` });
    }
    if (styleSettings && (styleSettings.character.length > 100 || styleSettings.scene.length > 100)) {
      return res.status(400).json({
        success: false,
        error: "Character or scene description exceeds 100 characters",
      });
    }

    // Prepare file paths
    const userId = String(user.id);
    const fileName = `image-${Date.now()}-${index}.png`;
    const userDir = join(process.cwd(), 'public', 'generated-images', userId);
    await fs.mkdir(userDir, { recursive: true });
    const filePath = join(userDir, fileName);
    // Secure API URL for access
    const staticImageUrl = `/generated-images/${userId}/${fileName}`;

    // Build style prompt dynamically
    let descriptionPrompt = imageDescription ? `Mô tả ảnh: ${imageDescription}.` : "";
    let stylePrompt = styleSettings && styleSettings.style ? `Phong cách: ${styleSettings.style}.` : "";
    
    // Thêm mô tả nhân vật và bối cảnh nếu có
    let characterPrompt = styleSettings && styleSettings.character ? `Nhân vật: ${styleSettings.character}.` : "";
    let scenePrompt = styleSettings && styleSettings.scene ? `Bối cảnh: ${styleSettings.scene}.` : "";

    // Process request
    let buffer: Buffer;
    if (file) {
      try {
        if (file.base64) {
          const matches = file.base64.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
          if (!matches) {
            return res.status(400).json({ success: false, error: "Invalid base64 image format" });
          }
          const base64Data = matches[2];
          const imageBuffer = Buffer.from(base64Data, "base64");
          buffer = await sharp(imageBuffer)
            .resize(512, 512, { fit: "fill" })
            .png()
            .toBuffer();
        } else {
          const data = await fs.readFile(file.filepath);
          buffer = await sharp(data)
            .resize(512, 512, { fit: "fill" })
            .png()
            .toBuffer();
        }
        await fs.writeFile(filePath, buffer);
        return res.status(200).json({
          success: true,
          imageUrl: staticImageUrl,
          direct_image_url: staticImageUrl,
          image_path: filePath,
          index,
        });
      } catch (error: any) {
        console.error("Image processing error:", error);
        return res.status(500).json({ success: false, error: "Failed to process uploaded image" });
      }
    } else if (prompt) {
      try {
        // Sử dụng Google GenAI để tạo ảnh
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
          return res.status(500).json({ success: false, error: "Missing GEMINI_API_KEY" });
        }

        // Chuẩn bị prompt cho Google GenAI
        const fullPrompt = [
          prompt,
          descriptionPrompt,
          stylePrompt,
          characterPrompt,
          scenePrompt
        ].filter(Boolean).join("\n");
        
        console.log("Generating image with prompt:", fullPrompt);

        // Gọi API Gemini 2.0 Flash để tạo ảnh
        console.log(`Generating image with prompt: ${fullPrompt}`);
        
        // Bỏ qua model_id từ frontend, luôn sử dụng model chính xác
        console.log("Using model: gemini-2.0-flash-exp-image-generation (ignoring any model_id from frontend)");
        
        const imageData = await generateImageWithGemini(fullPrompt, apiKey);
        
        if (!imageData) {
          return res.status(500).json({ 
            success: false, 
            error: "Failed to generate image with Gemini 2.0 Flash" 
          });
        }
        
        // Xử lý kết quả từ Google GenAI
        if (!imageData.mimeType || !imageData.data) {
          console.error("Invalid image data structure:", JSON.stringify(imageData));
          return res.status(500).json({ 
            success: false, 
            error: "Invalid image data returned from Gemini API" 
          });
        }
        
        // Xử lý dữ liệu ảnh
        let imageBuffer: Buffer;
        try {
          // Chuyển đổi dữ liệu base64 thành buffer
          imageBuffer = Buffer.from(imageData.data, "base64");
          
          // Lấy phần mở rộng file từ MIME type
          const fileExtension = mime.getExtension(imageData.mimeType);
          if (!fileExtension) {
            console.warn(`Unknown mime type: ${imageData.mimeType}, defaulting to png`);
          }
          
          console.log(`Image generated successfully with MIME type: ${imageData.mimeType}`);
        } catch (error: any) {
          console.error("Error processing image data:", error);
          return res.status(500).json({ 
            success: false, 
            error: `Error processing image data: ${error.message}` 
          });
        }
        
        try {
          // imageBuffer đã được định nghĩa ở trên
          await fs.writeFile(filePath, imageBuffer);
        } catch (error: any) {
          console.error("Error saving image file:", error);
          return res.status(500).json({ success: false, error: `Error saving image: ${error.message}` });
        }

        // Trả về URL của ảnh
        return res.status(200).json({
          success: true,
          imageUrl: staticImageUrl,
          direct_image_url: staticImageUrl,
          image_path: filePath,
          index,
        });
      } catch (error: any) {
        console.error("Google GenAI error:", error);
        return res.status(500).json({ success: false, error: error.message || "Failed to generate image with Google GenAI" });
      }
    }
  } catch (error: any) {
    console.error("Error processing image:", error);
    return res.status(500).json({ success: false, error: error.message || "Failed to process image" });
  }
}

export const config = {
api: {
bodyParser: false,
},
};